export default function TeamBadge({
  badgeKey,
  color,
  size = 40,
  name,
}: {
  badgeKey: string;
  color: string;
  size?: number;
  name: string;
}) {
  const src = `/assets/badges/${badgeKey}.svg`;
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-full border border-white/15"
      style={{ width: size, height: size, background: color }}
      title={name}
    >
      <img
        src={src}
        alt={`${name} badge`}
        width={size}
        height={size}
        className="h-full w-full object-cover"
        onError={(e) => {
          const el = e.currentTarget;
          el.style.display = "none";
          const parent = el.parentElement;
          if (parent && !parent.querySelector("span")) {
            const s = document.createElement("span");
            s.className =
              "grid h-full w-full place-items-center font-display text-[10px] font-bold text-ink";
            s.textContent = name
              .split(" ")
              .map((w) => w[0])
              .join("")
              .slice(0, 3);
            parent.appendChild(s);
          }
        }}
      />
    </div>
  );
}
