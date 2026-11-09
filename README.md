# Test

Claude Code project setup (`.claude/`):

- `skills/` — skills from Leonxlnx/taste-skill, emilkowalski/skills, nextlevelbuilder/ui-ux-pro-max-skill and the ECC fork centrender/everything-claude-code-affaanmustafa
- `agents/`, `commands/` — ECC agents and slash commands
- `ecc/` — ECC hook scripts; `settings.json` wires them in (via `CLAUDE_PLUGIN_ROOT=$CLAUDE_PROJECT_DIR/.claude/ecc`)

Hook behaviour can be tuned with ECC env flags (e.g. `ECC_HOOK_PROFILE`, `ECC_DISABLED_HOOKS`); remove entries from `.claude/settings.json` to disable a hook.

## Проект «Комбайн»

- `docs/PRD.md` — требования к продукту
- `docs/schema.sql` — схема данных PostgreSQL (Supabase), проверена на PostgreSQL 16
- `docs/design/mockup.html` — макет интерфейса (открыть в браузере)
