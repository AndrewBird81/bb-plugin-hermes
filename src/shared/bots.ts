// How bb names a bot (README glossary "bot", r11 §2): its Bot Mode handle, else the profile name;
// `default` shows as "Hermes". No Node imports: the app uses it.

export function botLabel(name: string, handle: string | null = null): string {
  if (name === "default") return "Hermes";
  const shown = handle && handle !== "hermes" ? handle : name;
  return shown.charAt(0).toUpperCase() + shown.slice(1);
}

/** The bot thread's title (01 §3) and the side chat's placeholder title (02 flow 2). */
export const botThreadTitle = (label: string) => label;
export const newChatTitle = (label: string) => `New ${label} chat`;
