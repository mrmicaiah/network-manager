# Login Flow Review - Findings and Recommendations

## Overview

Reviewed the SMS-based authentication flow for the Bethany dashboard. The implementation is solid with proper security measures, but there are some UX improvements and missing features to address.

---

## ✅ What's Working Well

### Backend (auth-service.ts)
- **6-digit verification codes** with HMAC-SHA256 hashing
- **10-minute code expiry** — appropriate window
- **3 max attempts per code** — prevents brute force
- **5 codes per phone per hour** — rate limiting in place
- **7-day JWT sessions** with auto-refresh when < 3 days remaining
- **HttpOnly, Secure, SameSite=Lax cookies** — proper security
- **Constant-time comparison** for code verification
- **E.164 phone normalization** — handles various input formats

### Frontend (LoginPage.tsx)
- **Two-step flow** (phone → code) works correctly
- **Already authenticated redirect** — prevents double login
- **Location state redirect** — preserves intended destination
- **Numeric input mode** for code entry
- **Code auto-trimmed** to 6 digits
- **Error display** for failed attempts
- **"Use different number" option** — good escape hatch

---

## ⚠️ Issues Found

### 1. Missing Phone Number Formatting (LoginPage.tsx)
**Issue:** Phone input has no formatting — users type raw digits.
**Impact:** Poor UX compared to signup page which has nice `(555) 123-4567` formatting.

### 2. Missing Resend Code Timer (LoginPage.tsx)
**Issue:** No countdown timer or resend button on the code entry step.
**Impact:** Users who don't receive the code have no clear way to request a new one.

### 3. Missing Welcome Message for New Signups (LoginPage.tsx)
**Issue:** No handling for `?welcome=true` query param from signup redirect.

### 4. Missing CORS Headers on Auth Responses (auth-service.ts)
**Issue:** Auth route responses don't consistently include CORS headers.
**Impact:** Cross-origin dashboard won't receive proper error responses.

### 5. Credentials Not Included in Auth Requests (AuthContext.tsx)
**Issue:** `requestCode` fetch doesn't include `credentials: 'include'`.

### 6. API URL Hardcoded as Relative Path (AuthContext.tsx)
**Issue:** Auth API calls use relative paths which only work if dashboard is served from same origin.

---

## 🔧 Priority Fixes

### Priority 1: Critical for Cross-Origin (Must Fix Before Deploy)

1. Add VITE_API_URL environment variable to dashboard build
2. Update AuthContext.tsx to use API_URL for all requests
3. Add `credentials: 'include'` to all auth requests
4. Add CORS headers to all auth-service response handlers

### Priority 2: UX Improvements (Should Fix)

5. Add phone formatting to LoginPage.tsx (match signup page)
6. Add resend code button with 60-second countdown
7. Handle `?welcome=true` query param for new signups

---

## Files Modified

- `dashboard/src/context/AuthContext.tsx` - API URL and credentials
- `dashboard/src/pages/LoginPage.tsx` - Phone formatting, resend timer, welcome message
- `worker/services/auth-service.ts` - CORS headers

---

*Review completed: February 2026*
