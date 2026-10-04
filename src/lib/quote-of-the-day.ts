import quotes from "../../quotes.json";
import { t } from "../i18n";
import { toLocalDateString } from "./date";
import { hashString } from "./hash";

type Quote = {
  quote: string;
  author: string;
  language: string;
  category: string;
};

const quoteList = quotes as Quote[];

export const getQuoteOfTheDay = (date = new Date()) => {
  if (quoteList.length === 0) {
    return {
      quote: t("quoteFallback", { ns: "common" }),
      author: "Trackdidia",
      language: "fr",
      category: "fallback",
    };
  }

  const index = hashString(toLocalDateString(date)) % quoteList.length;

  return quoteList[index];
};
