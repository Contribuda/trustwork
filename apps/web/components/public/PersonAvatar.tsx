
export type PersonAvatarProps = {
  name: string;
  /** Manifest id of a consented portrait; null → initials on the accent tint. */
  portrait: string | null;
  size?: 32 | 36 | 40 | 48 | 64 | 96 | undefined;
  className?: string | undefined;
};

function initials(name: string): string {
  return name
    .split(' ')
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('');
}

/** Round avatar: the person's consented portrait when present, otherwise initials. Decorative (the name is rendered next to it). */
export function PersonAvatar({ name, portrait, size = 40, className }: PersonAvatarProps) {
  // The engine ships no photographs: a consented portrait id stays in the data and renders as initials until a deployment registers its own licensed portraits.
  void portrait;
  return (
    <span className={['p-avatar', className].filter(Boolean).join(' ')} style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}
