/**
 * Shared type definitions for the Bethany Network Manager.
 *
 * Env bindings, and re-exports for downstream modules.
 * Data models (Contact, Circle, User, etc.) live in shared/models.ts (TASK-2cbc00d4-4).
 * Intent configuration lives in shared/intent-config.ts (TASK-f94df59b-a).
 */

// ---------------------------------------------------------------------------
// Cloudflare Worker Environment Bindings
// ---------------------------------------------------------------------------
export interface Env {
  // D1 Database
  DB: D1Database;

  // R2 Storage (bulk imports, exports, backups)
  STORAGE: R2Bucket;

  // Durable Objects
  ONBOARDING_DO: DurableObjectNamespace;      // Post-signup onboarding
  USER_DISCOVERY_DO: DurableObjectNamespace;  // Pre-signup discovery
  NUDGE_CONTEXT_DO: DurableObjectNamespace;   // Proactive nudge follow-up
  INTENT_SORTING_DO: DurableObjectNamespace;  // Intent assignment sessions

  // Secrets — Core
  ANTHROPIC_API_KEY: string;
  SENDBLUE_API_KEY: string;
  SENDBLUE_API_SECRET: string;
  SENDBLUE_PHONE_NUMBER: string;
  PIN_SIGNING_SECRET: string;
  INTERNAL_API_KEY: string;

  // Secrets — Stripe
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;

  // Vars
  ENVIRONMENT: string;
  BETHANY_WORKER_URL: string;
  SIGNUP_BASE_URL: string;   // Base URL for signup links
  MAX_FREE_CONTACTS: string; // wrangler vars are always strings
  TRIAL_DAYS: string;
  DASHBOARD_URL: string;     // URL for redirects after Stripe checkout
}

// ---------------------------------------------------------------------------
// API Response Helpers
// ---------------------------------------------------------------------------
export interface ApiError {
  error: string;
  code?: string;
  details?: string;
}

export interface ApiSuccess<T = unknown> {
  data: T;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}
