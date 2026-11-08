// `assets/skill/SKILL.md` is bundled as text (`with { type: "text" }`, bb's host build); vitest loads it the same way.
declare module "*.md" {
  const text: string;
  export default text;
}
