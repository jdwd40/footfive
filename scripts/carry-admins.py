#!/usr/bin/env python3
"""Carry login accounts from an archived FootFive DB into a fresh one.

Copies the PocketBase superusers and the app admin users (role = 'admin') with their
existing password hashes and token keys, so they log in exactly as before. Game data,
credits and other accounts are not copied. Passwords are never read in clear text.

Usage: carry-admins.py OLD_DB NEW_DB   (run with PocketBase stopped)
"""
import sqlite3
import sys

old_path, new_path = sys.argv[1], sys.argv[2]
old = sqlite3.connect(f"file:{old_path}?mode=ro", uri=True)
new = sqlite3.connect(new_path)


def cols(db, table):
    return [r[1] for r in db.execute(f"pragma table_info({table})")]


def carry(table, where):
    shared = [c for c in cols(old, table) if c in cols(new, table)]
    rows = old.execute(f"select {','.join(shared)} from {table} where {where}").fetchall()
    for r in rows:
        values = dict(zip(shared, r))
        if table == "users":
            values["credits"] = 1000  # fresh wallet, same as any new account
        keys = list(values)
        new.execute(
            f"insert or replace into {table} ({','.join(keys)}) values ({','.join('?' * len(keys))})",
            [values[k] for k in keys],
        )
    return [r[shared.index("email")] for r in rows]


with new:
    su = carry("_superusers", "1=1")
    admins = carry("users", "role = 'admin'")
print({"superusers": su, "admins": admins})
assert new.execute("select count(*) from users where role='admin'").fetchone()[0] == len(admins)
