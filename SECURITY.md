# Security Policy

## Supported versions

InkMarshal is currently pre-release software.

| Version | Security support |
| --- | --- |
| Latest commit on `main` before the first public release | Supported on a best-effort basis |
| Latest stable release after public launch | Supported |
| Older releases and development branches | Not supported; reproduce against the latest supported version first |

Security fixes may require upgrading to the latest release. The project does not maintain compatibility branches for unpublished internal builds.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

1. Prefer [GitHub Security Advisories](https://github.com/mike007jd/InkMarshal/security/advisories/new) to submit a private report with affected versions, impact, reproduction steps, and any proof of concept.
2. If private vulnerability reporting is unavailable, contact the maintainers through the repository owner's private channel. Before public launch, replace this placeholder with a monitored security mailbox: `security@inkmarshal.example` (**placeholder; not a live inbox**).
3. Do not include real API keys, private manuscripts, personal data, or destructive payloads. Use minimal test data.

Reports about leaked credentials should identify the affected provider and repository location, but should not repeat the credential. Revoke exposed credentials immediately with the provider.

## Response expectations

- Acknowledgement: within 3 business days.
- Initial triage and severity assessment: within 7 calendar days.
- Status updates: at least every 14 calendar days while remediation is active.
- Target remediation: critical/high issues within 30 days when feasible; lower-severity issues are scheduled according to risk and release cadence.

Timelines may change for complex or upstream vulnerabilities. We will communicate material delays and coordinate a disclosure date with the reporter. Please allow a fix and supported release to be available before public disclosure.

## Scope

Useful reports include vulnerabilities in the desktop runtime boundary, local API authorization, secret handling, update signature verification, model/download integrity, manuscript access, import/export parsing, and dependency supply chain.

Unsupported reports include social engineering, denial of service requiring sustained traffic against infrastructure the project does not operate, and findings that only affect obsolete or modified builds.
