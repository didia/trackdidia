/** Static description of one ritual section: where it links to, if anywhere. */
export interface RitualSectionMeta<K extends string> {
  key: K;
  linkTo?: string;
  /** Translation key of the link label, relative to the `reviews` namespace. */
  linkKey?: string;
}

/** A ritual section with its copy already translated. */
export interface RitualSection<K extends string> {
  key: K;
  title: string;
  subtitle: string;
  prompt: string;
  linkTo?: string;
  linkLabel?: string;
}

/** Looks up a `reviews` translation by a key assembled at runtime. */
export type RitualTranslate = (key: string) => string;

/**
 * Translates ritual section meta into display sections. `prefix` is the review surface's
 * translation scope (`weekly.ritual` or `monthly.ritual`); each section reads
 * `${prefix}.${key}.title|subtitle|prompt`.
 */
export const buildRitualSections = <K extends string>(
  meta: ReadonlyArray<RitualSectionMeta<K>>,
  translate: RitualTranslate,
  prefix: string,
): RitualSection<K>[] =>
  meta.map((section) => ({
    key: section.key,
    title: translate(`${prefix}.${section.key}.title`),
    subtitle: translate(`${prefix}.${section.key}.subtitle`),
    prompt: translate(`${prefix}.${section.key}.prompt`),
    linkTo: section.linkTo,
    linkLabel: section.linkKey ? translate(section.linkKey) : undefined,
  }));
