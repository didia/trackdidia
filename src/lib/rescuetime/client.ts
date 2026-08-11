import type { RescueTimeTaxonomy } from "../../domain/types";
import type { RescueTimeAnalyticPayload } from "./parse-analytic-data";
import { fetchRescueTimeJson } from "./http-transport";

export interface RescueTimeFetchOptions {
  kind: RescueTimeTaxonomy;
  begin: string;
  end: string;
  scheduleId?: number;
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
    if (options.scheduleId !== undefined && options.scheduleId > 0) {
      url.searchParams.set("restrict_schedule_id", String(options.scheduleId));
    }

    return fetchRescueTimeJson<RescueTimeAnalyticPayload>(url.toString(), apiKey);
  }
}

export const defaultRescueTimeClient = new HttpRescueTimeClient();
