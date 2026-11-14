# Handbook reference worksheet

**Status: machine lookups awaiting human confirmation. This is not gold.**

Each row is a value read from one primary page on Sat 14 Nov 2026 between 17:25 and 17:40 London time, by Bill's agent Fable using automated page fetches. A summarising model read each page, so a row can be wrong. Before any row is used for scoring, a person must open the link, read the value, and write their name and the time in the last two columns. The evaluator's gold file is then written from the confirmed rows.

Keep this file away from the audit's input. The runner only ever reads the single handbook page named on its command line.

| Fact | Page and line | Handbook says | Found on the source | Source | Expected label | Confirmed by | Confirmed at (UTC) |
|---|---|---|---|---|---|---|---|
| f01 Python latest stable release | developer-tooling.md:5 | 3.11 | 3.15 (the download button reads 3.15.2) | https://www.python.org/downloads/ | stale | | |
| f02 Node.js latest long-term support line | developer-tooling.md:7 | 18 | 26 (v26 "Lithium" is marked LTS and "Latest LTS"; v18 is EOL) | https://nodejs.org/en/about/previous-releases | stale | | |
| f03 Rust current edition | developer-tooling.md:9 | 2021 | 2024 (released with Rust 1.85.0; no newer edition listed) | https://doc.rust-lang.org/edition-guide/rust-2024/index.html | stale | | |
| f04 GitHub file size block | developer-tooling.md:11 | 100 MiB | 100 MiB ("GitHub blocks files larger than 100 MiB") | https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github | fresh | | |
| f05 GitHub default branch name | developer-tooling.md:13 | main | main ("GitHub names the default branch main in any new repository") | https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-branches | fresh | | |
| f06 Docker Desktop paid threshold | developer-tooling.md:15 | 250 employees | 250 (free tier is "fewer than 250 employees AND less than $10 million in annual revenue") | https://docs.docker.com/subscription/desktop-license/ | fresh | | |
| f07 Ubuntu latest long-term support release | platform-and-standards.md:5 | 22.04 | 26.04 LTS (released April 2026) | https://ubuntu.com/about/release-cycle | stale | | |
| f08 Debian current stable release | platform-and-standards.md:7 | 12 | 13 ("trixie") | https://www.debian.org/releases/ | stale | | |
| f09 PostgreSQL latest major version | platform-and-standards.md:9 | 15 | 18 (first released 25 Sep 2025; version 19 was at release candidate 2 and not in the table) | https://www.postgresql.org/support/versioning/ | stale | | |
| f10 WCAG latest published version | platform-and-standards.md:11 | 2.1 | 2.2 (published 5 Oct 2023; WCAG 3 is an early draft) | https://www.w3.org/WAI/standards-guidelines/wcag/ | stale | | |
| f11 TLS newest version | platform-and-standards.md:13 | 1.3 | 1.3 (a 2026 RFC revises TLS 1.3 without a new version number) | https://en.wikipedia.org/wiki/Transport_Layer_Security | fresh | | |
| f12 AWS Lambda maximum run time | platform-and-standards.md:15 | 15 minutes | 900 seconds (15 minutes). The page also gives 90 minutes for one special case, Lambda Managed Instances | https://docs.aws.amazon.com/lambda/latest/dg/configuration-timeout.html | fresh, with a caveat | | |
| f13 National Living Wage, 21 and over | uk-payroll-and-tax.md:5 | £11.44 | £12.71 (from April 2026; £13.21 is listed for April 2027) | https://www.gov.uk/national-minimum-wage-rates | stale | | |
| f14 Employer National Insurance rate | uk-payroll-and-tax.md:7 | 13.8% | 15% (category A, above the secondary threshold) | https://www.gov.uk/guidance/rates-and-thresholds-for-employers-2026-to-2027 | stale | | |
| f15 Bank of England base rate | uk-payroll-and-tax.md:9 | 5.25% | 4% (changed 5 Nov 2026; next decision 17 Dec 2026) | https://www.bankofengland.co.uk/monetary-policy/the-interest-rate-bank-rate | stale | | |
| f16 Standard rate of VAT | uk-payroll-and-tax.md:11 | 20% | 20% | https://www.gov.uk/vat-rates | fresh | | |
| f17 Corporation tax main rate | uk-payroll-and-tax.md:13 | 25% | 25% | https://www.gov.uk/corporation-tax-rates | fresh | | |
| f18 Income tax personal allowance | uk-payroll-and-tax.md:15 | £12,570 | £12,570 (tax year 6 April 2026 to 5 April 2027) | https://www.gov.uk/income-tax-rates | fresh | | |
| f19 React latest major version | web-and-languages.md:5 | 18 | 19 (the page's latest version is 19.3) | https://react.dev/versions | stale | | |
| f20 Java latest long-term support release | web-and-languages.md:7 | 17 | 25 (released 16 Sep 2025). Oracle's own roadmap page refused the automated fetch, so this came from Wikipedia: check Oracle's page by hand | https://en.wikipedia.org/wiki/Java_version_history | stale | | |
| f21 ECMAScript most recent edition | web-and-languages.md:9 | 2023 | 2026 (17th edition, June 2026) | https://ecma-international.org/publications-and-standards/standards/ecma-262/ | stale | | |
| f22 Go latest stable release | web-and-languages.md:11 | 1.21 | 1.27 (go1.27.0 on 19 Aug 2026; latest revision go1.27.4) | https://go.dev/doc/devel/release | stale | | |
| f23 HTTP newest version | web-and-languages.md:13 | HTTP/3 | HTTP/3 (RFC 9114, June 2022; nothing newer listed) | https://en.wikipedia.org/wiki/HTTP | fresh | | |
| f24 Kubernetes minor releases per year | web-and-languages.md:15 | three | "approximately three times per year" | https://kubernetes.io/releases/release/ | fresh | | |

## What the lookups changed

One fact was replaced because of them. The handbook first said "GitHub Free includes 2,000 GitHub Actions minutes per month". GitHub's billing page now states the free allowance as $12 of compute a month and gives no minutes figure, so that sentence could be argued either way. It was swapped for the file size limit in f04.

## Notes for the reviewer

- Two sources are Wikipedia because the primary page was unavailable or does not state the fact in one place: f11, f20 and f23. Prefer a primary source when you confirm them.
- f12 has a caveat. If the audit calls it "unsure" because of the 90-minute special case, that is a reasonable outcome and should not count as an error.
- f09: a release candidate of PostgreSQL 19 existed on the day of the lookup. If version 19 is released before the evaluation run, this row changes.
- f15 changes on Bank of England decision days. Note the time you checked.
