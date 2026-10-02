# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

The product is a TypeScript OpenCode V2 plugin. Its GitHub Pages developer guide uses dependency-free static HTML, CSS, and JavaScript, approved for this surface, deployed with GitHub Actions.

## Users

Developers evaluating or installing context compaction for long, tool-heavy OpenCode coding sessions. The developer-guide audience and purpose were confirmed during setup.

## Product Purpose

Use a decision model to classify completed tool calls and outputs for retention, rather than asking a generative model to rewrite conversation history. Help site visitors understand this mechanism and install the plugin.

## Capabilities and Constraints

- Experimental OpenCode V2 plugin, version 0.2.0 in the repository.
- Hosted TypeSafe JEV and an LM Studio-compatible Jev-Style Qwen3.5 2B v1 classifier are supported.
- The Jev-Style 0.8B v3 dedicated scoring runtime is not directly integrated.
- Retained text is copied into a deterministic checkpoint; OpenCode's current summary-string hook flattens the message structure.
- The first and recent messages are pinned; classifier failure or insufficient reduction falls back to native compaction.
- The public site must require no credentials, send no classifier requests, and explicitly label demonstration data as illustrative.

## Evidence on Hand

README.md is the factual source of truth for setup, supported backends, defaults, limitations, troubleshooting, and credits. No benchmark, customer, or measured savings claims are available.

## Brand Commitments

Preserve the repository name fast-jev-compaction-opencode and experimental status. No incumbent frontend, logo, or visual identity exists. The user delegated a distinctive technical editorial direction for the site.

## Product Principles

- Explain retention without implying generative summarization.
- Surface conservative behavior and limitations alongside installation.
- Keep backend compatibility explicit.
- Prefer runnable, copyable instructions over unsupported claims.
