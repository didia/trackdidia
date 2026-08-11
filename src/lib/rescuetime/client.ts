import type { RescueTimeTaxonomy } from "../../domain/types";
import type { RescueTimeAnalyticPayload } from "./parse-analytic-data";

export interface RescueTimeFetchOptions {
  kind: RescueTimeTaxonomy;
  begin: string;
  end: string;
}

export interface RescueTimeClient {
  fetchAnalyticData(apiKey: string, options: RescueTimeFetchOptions): Promise<RescueTimeAnalyticPayload>;
}

export class HttpRescueTimeClient implements RescueTimeClient {
  async fetchAnalyticData(apiKey: string, options: RescueTimeFetchOptions): Promise<RescueTimeAnalyticPayload> {
    const url = new URL("https://www.rescuetime.com/anapi/data");
    url.searchParams.set("format", "json");
    url.searchParams.set("perspective", "rank");
    url.searchParams.set("restrict_kind", options.kind);
    url.searchParams.set("restrict_begin", options.begin);
    url.searchParams.set("restrict_end", options.end);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`RescueTime API ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.json() as Promise<RescueTimeAnalyticPayload>;
  }
}

export const defaultRescueTimeClient = new HttpRescueTimeClient();
