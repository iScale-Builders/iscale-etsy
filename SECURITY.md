# Security Policy

## Reporting a Vulnerability

Please report security issues privately by emailing contact@iscalelabs.com.

Include a clear description, reproduction steps, affected files or pages, the
extension version (shown at `chrome://extensions`), and any supporting
screenshots or logs. Do not open public issues for vulnerabilities.

We will review reports as quickly as possible and coordinate a fix before
public disclosure when the issue is valid.

## Scope

This policy covers the iScale Etsy browser extension and this
repository. Relevant issues include:

- unintended data upload or network transmission
- private key, token, or endpoint exposure
- unsafe file import/export behavior
- extension permission overreach
- data deletion bugs

Out of scope:

- Social engineering
- Denial-of-service testing
- Automated scans that create excessive traffic
- Issues in third-party services (including Etsy) unless this extension's
  integration is the source of the vulnerability

## Supported Versions

Only the latest released version is supported. Please update before reporting.

## Design Baseline

The public edition is local-first and must not require credentials, hosted
databases, or private production services.
