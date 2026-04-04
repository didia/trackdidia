import quotes from "../../quotes.json";

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

const hashString = (value: string) => {
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
};

export const getQuoteOfTheDay = (date = new Date()) => {
  if (quoteList.length === 0) {
    return {
      quote: "Une journee bien tenue a la fois.",
      author: "Trackdidia",
      language: "fr",
      category: "fallback"
    };
  }

  const index = hashString(getDateKey(date)) % quoteList.length;

  return quoteList[index];
};
