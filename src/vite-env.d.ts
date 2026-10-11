/// <reference types="vite/client" />

/** pdf.js ships no types for its worker bundle; it only needs to be imported and handed over. */
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
