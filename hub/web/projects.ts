// A project card's main button. Games say "Play"; a project that isn't one names its own verb
// in projects.json ("action": "Try"), and the README's Live link uses the same verb in lowercase.
export type Named = { title: string; action?: string };

/** The button's verb: the project's own, or "Play". */
export const action = (p: Named) => p.action?.trim() || "Play";

/** The button's text, like "Play Afterstep" or "Try Sayfold". */
export const cta = (p: Named) => `${action(p)} ${p.title}`;
