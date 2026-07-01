/**
 * Minimal types for the parts of the Meta (Facebook) Graph API we consume.
 * These intentionally cover only the fields the app reads, not the full schema.
 */

export interface MetaInsightAction {
  action_type: string;
  value?: string;
}

export interface MetaInsight {
  campaign_id?: string;
  campaign_name?: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  actions?: MetaInsightAction[];
  cost_per_action_type?: MetaInsightAction[];
}

export interface MetaApiError {
  message?: string;
  type?: string;
  code?: number;
  fbtrace_id?: string;
}

export interface MetaInsightsResponse {
  data?: MetaInsight[];
  error?: MetaApiError;
}

/** A Meta ad account as returned by `me/adaccounts`. */
export interface MetaAdAccount {
  id?: string;
  name?: string;
  currency?: string;
  account_status?: number;
  user_tasks?: string[];
  adspixels?: { data?: Array<{ id?: string }> };
}

/** A Facebook Page as returned by `me/accounts`. */
export interface MetaPage {
  id?: string;
  name?: string;
  access_token?: string;
}
