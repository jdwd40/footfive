#!/usr/bin/env python3
"""Consistent, verified PocketBase data backup that never stops PocketBase.

Usage: python3 scripts/pb-data-backup.py PB_DATA DEST
       sudo -n python3 -I - PB_DATA DEST < scripts/pb-data-backup.py   (deploy, over SSH)

Each top-level SQLite database in PB_DATA (data.db, auxiliary.db, ...) is copied
with the SQLite online backup API from a read-only connection, so the snapshot holds
every committed transaction, including those still in the WAL, while PocketBase
keeps running. The live -wal/-shm/-journal files are never copied; each snapshot is
rewritten as a self-contained rollback-journal file and must pass PRAGMA
integrity_check. Every other file
(storage uploads and the rest) is copied with its mode and times, and its owner when
run as root. The backup is built in a hidden sibling staging directory and renamed
to DEST only once complete: any failure, SIGINT, SIGTERM or SIGHUP removes the
staging copy and exits non-zero. Refused before any work: an existing DEST (even a
dangling symlink), a DEST inside PB_DATA, a missing data.db, or any top-level *.db
that is not a valid SQLite database. Python stdlib
only; no sqlite3 CLI needed.
"""
import os
import shutil
import signal
import sqlite3
import stat
import sys
import tempfile
import time
from urllib.request import pathname2url

HEADER = b"SQLite format 3\x00"
LIVE = ("-wal", "-shm", "-journal")
LOCK_WAIT = 120  # seconds a locked source database may delay the snapshot


def fail(message):
    raise RuntimeError(message)


def is_sqlite(path):
    with open(path, "rb") as f:
        return f.read(16) == HEADER


def keep_owner(src_stat, dst):
    if os.geteuid() == 0:
        os.lchown(dst, src_stat.st_uid, src_stat.st_gid)


def snapshot(src, dst):
    deadline = time.monotonic() + LOCK_WAIT

    # Called between backup attempts: the backup API otherwise retries a locked
    # source forever inside C, where neither signals nor a time limit can act.
    def progress(_status, _remaining, _total):
        if time.monotonic() > deadline:
            fail("%s stayed locked for over %d seconds" % (src, LOCK_WAIT))

    source = sqlite3.connect("file:%s?mode=ro" % pathname2url(src), uri=True, timeout=0.5)
    try:
        target = sqlite3.connect(dst)
        try:
            source.backup(target, progress=progress, sleep=0.1)
            # Self-contained file: later reads never create -wal/-shm beside it;
            # PocketBase switches a restored copy back to WAL when it opens it.
            mode = target.execute("PRAGMA journal_mode=DELETE").fetchone()
            result = target.execute("PRAGMA integrity_check").fetchall()
        finally:
            target.close()
    finally:
        source.close()
    if mode != ("delete",) or result != [("ok",)]:
        fail("%s snapshot failed verification: journal_mode %s, integrity_check %s" % (src, mode, result[:3]))
    leftovers = [dst + s for s in LIVE if os.path.lexists(dst + s)]
    if leftovers:
        fail("snapshot left live files behind: %s" % leftovers)
    src_stat = os.stat(src)
    os.chmod(dst, stat.S_IMODE(src_stat.st_mode))
    keep_owner(src_stat, dst)


def copy_tree(src_root, stage, databases):
    skip = {name + s for name in databases for s in ("",) + LIVE}
    copied = 0
    for dirpath, dirnames, filenames in os.walk(src_root):
        rel = os.path.relpath(dirpath, src_root)
        out = stage if rel == "." else os.path.join(stage, rel)
        for name in list(dirnames):
            src = os.path.join(dirpath, name)
            if os.path.islink(src):  # copied as a link, never followed
                dirnames.remove(name)
                filenames.append(name)
            else:
                os.mkdir(os.path.join(out, name))
        for name in filenames:
            if rel == "." and name in skip:
                continue
            src, dst = os.path.join(dirpath, name), os.path.join(out, name)
            try:
                if os.path.islink(src):
                    os.symlink(os.readlink(src), dst)
                else:
                    shutil.copy2(src, dst)
                keep_owner(os.lstat(src), dst)
            except FileNotFoundError:
                print("note: %s vanished during the backup" % src, file=sys.stderr)
                continue
            copied += 1
    # Directory modes, times and owners last, deepest first, once their contents exist.
    for dirpath, _, _ in sorted(os.walk(src_root), key=lambda w: -w[0].count(os.sep)):
        rel = os.path.relpath(dirpath, src_root)
        out = stage if rel == "." else os.path.join(stage, rel)
        shutil.copystat(dirpath, out)
        keep_owner(os.stat(dirpath), out)
    return copied


def backup(src_root, dest):
    src_root = os.path.realpath(src_root)
    dest = os.path.abspath(dest)
    if not os.path.isfile(os.path.join(src_root, "data.db")):
        fail("%s is not a PocketBase data directory (no data.db)" % src_root)
    if os.path.lexists(dest):
        fail("%s already exists; refusing to overwrite or merge a backup" % dest)
    parent = os.path.dirname(dest)
    if not os.path.isdir(parent):
        fail("backup parent %s does not exist" % parent)
    inside = os.path.join(os.path.realpath(parent), os.path.basename(dest))
    if inside == src_root or inside.startswith(src_root + os.sep):
        fail("%s resolves inside %s; a backup must live outside the data it copies" % (dest, src_root))
    # Every top-level *.db is a database: one that is not valid SQLite fails the backup.
    databases = sorted(
        name for name in os.listdir(src_root)
        if name.endswith(".db") and os.path.isfile(os.path.join(src_root, name))
    )
    for name in databases:
        if not is_sqlite(os.path.join(src_root, name)):
            fail("%s/%s is not an SQLite database" % (src_root, name))
    stage = tempfile.mkdtemp(prefix=".%s.partial-" % os.path.basename(dest), dir=parent)
    try:
        for name in databases:
            snapshot(os.path.join(src_root, name), os.path.join(stage, name))
        copied = copy_tree(src_root, stage, databases)
        if os.path.lexists(dest):
            fail("%s appeared during the backup; refusing to replace it" % dest)
        os.rename(stage, dest)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    print("pb_data snapshot %s: %d SQLite database(s) verified (%s), %d other file(s) copied"
          % (dest, len(databases), ", ".join(databases), copied))


def main(argv):
    if len(argv) != 3:
        print("Usage: pb-data-backup.py PB_DATA DEST", file=sys.stderr)
        return 2

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, interrupted)
    try:
        backup(argv[1], argv[2])
    except (OSError, RuntimeError, sqlite3.Error) as e:
        print("pb_data backup FAILED, nothing published: %s" % e, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
