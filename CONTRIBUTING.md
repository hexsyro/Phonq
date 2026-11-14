# Contributing to Phonq

Thanks for wanting to help! Phonq is a free, open-source project — every contribution matters,
from a typo fix to a whole feature.

## Quick start

```bash
git clone https://github.com/hexsyro/Phonq
cd Phonq
npm install
cp .env.example .env   # fill in DATABASE_URL, JAMENDO_CLIENT_ID, AUTH_SECRET, AUTH_GOOGLE_*
npx prisma migrate dev
npm run dev
```

## Before you code

- **Look for an existing issue** or open one describing what you want to do. Small PRs are easier
  to review and merge. Use the [bug report](.github/ISSUE_TEMPLATE/bug_report.md) and
  [feature request](.github/ISSUE_TEMPLATE/feature_request.md) templates.
- Check [ROADMAP.md](ROADMAP.md) to see where things are headed and [TODO.md](TODO.md) for open tasks.
- New to the codebase? Read [ARCHITECTURE.md](ARCHITECTURE.md) first — it's a 5-minute read.

## Good first issues

Want an easy on-ramp? Anything in the repo issues labelled `good first issue` is a great start.
Suggested first tasks:

- Improve an empty/error state with a retry button.
- Add a keyboard shortcut or polish a piece of UI.
- Write a unit test for a pure helper (`rate-limit`, `utils`, catalog fallback).
- Fix a typo or improve the docs / FAQ copy.

## Development workflow

```bash
# while working
npm run dev

# before pushing / opening a PR — these must pass
npm run lint
npm run typecheck
npm test
npm run build

# run the full GitHub workflow test suite locally (mirrors CI)
npm run test:workflow   # alias: npm run ci / npm run test:ci / npm run workflow:test
```

The same checks run in the GitHub Actions workflow (`.github/workflows/ci.yml`) on every
push and pull request, so run the workflow tests above before opening a PR to catch
bugs early. Pull requests that fail the workflow tests cannot be merged.

Contributors must run the workflow tests before make pull requests.

- Keep changes focused. One feature/fix per PR.
- Follow existing conventions (see "Conventions" in ARCHITECTURE.md): server components fetch data,
  mutations go through API routes, Tailwind 4 tokens, lucide-react icons.
- Write clear commit messages in the existing style.
- Open a PR with [the template](.github/PULL_REQUEST_TEMPLATE.md) so reviewers know what to check.

## What needs help

- **Docs** — README, ARCHITECTURE, FAQ content.
- **Translations** — the UI has no i18n yet; adding it would be a great first big task.
- **Features** — see the roadmap: artist/album pages, queue drag-and-drop, recommendations, stats.
- **Bugs & polish** — anything in the issue tracker, plus performance and mobile UX.
- **Testing** — extend the Vitest suite: the player state machine, API route handlers, and the
  catalog fallback ladder all need more coverage.
- **Catalog resilience** — the catalog layer (`src/lib/catalog.ts`) has a provider interface ready
  for a second CC source (e.g. Free Music Archive or ccMixter) behind the same interface.

## Code of conduct

Be kind. This is a volunteer project for the phonk community. Harassment, gatekeeping and
unconstructive criticism are not welcome.

## License

By contributing you agree that your contributions are licensed under the same MIT license
as the project. See [LICENSE](LICENSE).
