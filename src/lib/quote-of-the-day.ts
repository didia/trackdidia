import quotes from "../../quotes.json";
import { t } from "../i18n";
import { hashString } from "./hash";

type Quote = {
  quote: string;
  author: string;
  language: string;
  category: string;
};

const quoteList = quotes as Quote[];

const getDateKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

export const getQuoteOfTheDay = (date = new Date()) => {
  if (quoteList.length === 0) {
    return {
      quote: t("quoteFallback", { ns: "common" }),
      author: "Trackdidia",
      language: "fr",
      category: "fallback",
    };
  }

  const index = hashString(getDateKey(date)) % quoteList.length;

  return quoteList[index];
};
