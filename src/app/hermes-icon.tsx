// `assets/hermes.svg` inline (rail, row badge, provider icon): bb's icon slots take a component.
// A test keeps the paths equal to the asset's.
export const HERMES_PATHS = [
  "M7 7h2.6v4.7h4.8V7H17v13h-2.6v-5.7H9.6V20H7z",
  "M7 6.2C5.1 4.3 2.7 3.6.8 4c1 .6 1.8 1.4 2.3 2.3-.9 0-1.8.2-2.6.6 1.3.3 2.4.9 3.3 1.7H7z",
  "M17 6.2c1.9-1.9 4.3-2.6 6.2-2.2-1 .6-1.8 1.4-2.3 2.3.9 0 1.8.2 2.6.6-1.3.3-2.4.9-3.3 1.7H17z",
];

/** The app icon name the rail panel uses (registered with `experimental_icons`). */
export const HERMES_ICON = "hermes";

export function HermesIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      {HERMES_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
