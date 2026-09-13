import { formatBibleBookCodeList } from "../../pastor/bible-books";

export const buildPastorVerseSchemaPrompt = (
  allowedVerseIds: string[],
  offListAllowed: boolean,
): string => {
  const idList =
    allowedVerseIds.length > 0
      ? allowedVerseIds.join(", ")
      : "(aucun verset disponible dans le catalogue pour l'instant)";

  const offListRule = offListAllowed
    ? `Tu peux exceptionnellement choisir un verset hors catalogue ("pick":"outside") si aucun verset du catalogue ne convient vraiment. Dans ce cas fournis "reference" ({book, chapter, verseStart, verseEnd}, numérotation NRSVue/anglaise) et un "paraphraseFr". Codes de livres valides pour reference.book : ${formatBibleBookCodeList()}.`
    : `Un verset hors catalogue a déjà été proposé récemment : choisis obligatoirement "pick":"list" avec un verseId de la liste ci-dessus.`;

  const fields = `Champs requis (pastor_verse.v1):
- pick: "list" | "outside"
- verseId: obligatoire si pick="list", un des identifiants suivants : ${idList}
- reference: obligatoire si pick="outside" — {book, chapter, verseStart, verseEnd}
- paraphraseFr: obligatoire si pick="outside" (<= 400 caractères) ; jamais une citation mot pour mot
- principleKey: une clé de principe pertinente, ou null
- intent: "reinforcement" | "new_teaching" | "both"
- title (<= 80 caractères) : référence ou titre court en français
- explanation (<= 900 caractères, 3 à 5 phrases) : ancrage (lien avec le journal ou le principe) puis enseignement (angle nouveau ou pratique concrète)
- practice (optionnel, <= 160 caractères) : un geste concret pour aujourd'hui

${offListRule}

Ne cite jamais un verset biblique mot pour mot, même en paraphrasant de très près. Ne cite jamais le journal de l'utilisateur mot pour mot. Ne moralise pas et ne fais pas la leçon. Ne te présente jamais comme un message divin. Pas de diagnostic médical ou psychologique. Si le journal évoque une détresse, oriente doucement vers la prière et un soutien humain de confiance. Si les données sont peu nombreuses, choisis un verset largement encourageant.`;

  const exampleId = allowedVerseIds[0] ?? "exemple-id";
  const example = `Exemple minimal (pick="list"):
{"pick":"list","verseId":"${exampleId}","principleKey":null,"intent":"reinforcement","title":"Référence courte","explanation":"Ancrage bref lié au journal. Enseignement bref et concret.","practice":null}`;

  return [fields, example].join("\n\n");
};
