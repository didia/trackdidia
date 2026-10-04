export const buildFinanceCategorizationSchemaPrompt = (
  allowedCategories: Array<{ id: string; name: string }>,
): string => {
  const categoryList =
    allowedCategories.length > 0
      ? allowedCategories.map((category) => `${category.id} (${category.name})`).join(", ")
      : "(aucune categorie disponible)";

  const fields = `Champs requis (finance_categorization):
- merchants: Array<{ merchantKey: string; categoryId: string; confidence: number; rationale: string }>
  - une entree pour CHAQUE marchand du payload, dans le meme ordre, identifie par son merchantKey exact
  - categoryId doit etre l'un des identifiants autorises: ${categoryList}
  - confidence: nombre entre 0 et 1 (0 = incertain, 1 = certain)
  - rationale: courte explication en francais (ex: signalement d'un service connu, mot-cle du marchand)
  - n'invente jamais de merchantKey absent du payload, et n'ajoute aucun champ supplementaire`;

  const exampleMerchantKey = "EXEMPLE MARCHAND";
  const exampleCategoryId = allowedCategories[0]?.id ?? "fincat:exemple";
  const example = `Exemple minimal:
{"merchants":[{"merchantKey":"${exampleMerchantKey}","categoryId":"${exampleCategoryId}","confidence":0.8,"rationale":"Marchand reconnu"}]}`;

  return [fields, example].join("\n\n");
};
