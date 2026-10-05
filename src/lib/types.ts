export interface LeadFormData {
  name: string;
  email: string;
  phone?: string;
}

export interface LeadSubmission extends LeadFormData {
  tags: string[];
  source?: string;
}

export interface GHLContactPayload {
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  locationId: string;
  tags?: string[];
  source?: string;
}

export interface GHLResponse {
  success: boolean;
  contactId?: string;
  isDuplicate?: boolean;
  error?: string;
  statusCode?: number;
}

export interface GHLTagsResponse {
  success: boolean;
  error?: string;
  statusCode?: number;
}

export interface GHLLookupResponse {
  success: boolean;
  contactId?: string;
}

export interface QualifyFormData {
  email: string;
  responses: Record<string, string>;
}

export interface APIResponse {
  success: boolean;
  message: string;
  contactId?: string;
}
