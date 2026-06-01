# Requirements: LongCat Smart-Auto Preference

## Overview

When the router is in smart-auto mode, LongCat models should always be tried first if any LongCat API key still has remaining rate-limit capacity. If all LongCat keys are exhausted, the router falls through to normal smart Thompson Sampling routing for the remaining models.

## Context

The routing system in server/src/services/router.ts supports two modes. Balanced mode uses Thompson Sampling over success rate, speed, TTFB, and a small intelligence weight. Smart mode uses the same Thompson Sampling but with a much higher intelligence weight, making smarter models rank higher more consistently.

The smart mode is selected when the client sends model = "freellmapi/auto-smart" in server/src/routes/proxy.ts at line 939.

Currently, both modes are purely stochastic. LongCat may win often due to its intelligence rank of 6, but it is not guaranteed. This feature makes LongCat deterministically preferred in smart-auto mode only.

## Requirements

FR-1: LongCat First in Smart Mode

When routingMode is "smart", the router MUST attempt LongCat models before any other model, provided at least one LongCat API key passes all rate-limit checks: rpm, rpd, tpm, tpd, and cooldown.

FR-2: Rate-Limit Awareness

LongCat is only preferred if at least one of its enabled, non-invalid keys has remaining capacity according to the existing rate-limit checks. The canMakeRequest function checks rpm and rpd windows. The canUseTokens function checks tpm and tpd windows. The isOnCooldown function checks 429 cooldown state.

If ALL LongCat keys are exhausted, the router falls through to normal smart routing for all other models.

FR-3: Platform Scope

The preference applies to all models on the "longcat" platform, not a single specific model ID. This ensures future LongCat models automatically get the same preference.

FR-4: Balanced Mode Unchanged

The "balanced" routing mode must NOT be affected. It continues to use pure Thompson Sampling with no platform preference.

FR-5: Explicit Model Requests Unchanged

When a client explicitly requests a specific model by ID, routing goes directly to that model as before. The LongCat preference only applies to auto-smart routing.

FR-6: Sticky Session Interaction

The existing sticky session mechanism continues to work. If a sticky session is already established for a non-LongCat model, the LongCat preference should NOT override it. Sticky sessions take precedence as they prevent hallucination from model switching mid-conversation.

## Out of Scope

- Changes to the balanced routing mode
- Changes to the Thompson Sampling algorithm itself
- Changes to rate-limit tracking or enforcement
- Changes to the fallback chain ordering in balanced mode
- Any provider other than longcat
