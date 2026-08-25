# Tri-lingual quality test (JA / EN / ZH)

Tracks issue #8. V1 quality testing only covered English. The Improve-formatting
prompt was later hardened (Obsidian-syntax preserve list, "return unchanged if
already clean", "never translate") and a CJK token-cap bug was fixed — none of
which was re-tested on Japanese or Chinese.

This is a **manual** test: the model runs only inside Obsidian, so it can't be
run from CI. Drop the three fixtures below into a scratch note, run each command,
and check against the pass criteria.

## How to run

1. Reload the plugin so the latest build is active.
2. For each fixture: paste it into a **new throwaway note** (never a real note —
   Improve overwrites), select the whole thing, run **Improve formatting of
   active note**, and review the preview before approving.
3. Also run **Ingest active note into wiki** on each and check the drafted card.

## Pass criteria (same for all three languages)

- **Preserved verbatim:** wording/voice, `[[wikilinks]]`, `![[embeds]]`, `#tags`,
  `> [!callouts]`, code blocks, tables, ASCII/box diagrams, YAML frontmatter.
- **Never translated** — a Japanese note stays Japanese, a Chinese note stays
  Chinese.
- Only structure/formatting/obvious typos change.
- An already-clean passage comes back **unchanged**.
- No truncation (the CJK token-cap fix — a long CJK note must not get cut off
  mid-sentence).
- Ingest card: summary + 3 tags + key points, in the note's own language.

---

## Fixture EN

```markdown
## thoughts on   caching

caching  is basically about were the data lives.  a [[closure]] keeps its
own copy. teh cache invalidation problem  is one of the two hard things.

- `TTL` based expiry
- LRU eviction

> [!note] this callout must survive

then vs than: this is were people get it wrong more often then not.
```

Expect: typos fixed (teh→the, were→where, then→than), list/spacing tidied,
`[[closure]]`, `` `TTL` ``, the callout all preserved, English kept.

## Fixture JA

```markdown
## キャッシュ について

キャッシュ は データ が どこ に あるか の 話。  [[クロージャ]] は
自分 の コピー を 持つ。 TTL ベース の 期限切れ と LRU 。

- `TTL` による失効
- LRU による退避

> [!note] このコールアウトは残ること

てにをは が おかしい 文 を 直す。
```

Expect: spacing/formatting tidied, `[[クロージャ]]` / `` `TTL` `` / callout
preserved, **stays Japanese** (no English translation).

## Fixture ZH

```markdown
## 关于  缓存 的笔记

缓存 本质 上 是 数据 存 在 哪里 的问题。  [[闭包]] 保留 自己 的 副本。
缓存 失效 是 两 大 难题 之一 。

- 基于 `TTL` 的过期
- LRU 淘汰

> [!note] 这个 callout 必须保留

的地得 用错 是 很 常见 的 错误。
```

Expect: spacing tidied, `[[闭包]]` / `` `TTL` `` / callout preserved, **stays
Chinese** (no English translation), no mid-sentence truncation.

---

## Result log (fill in after running)

| Fixture | Improve: preserved? | Improve: not translated? | Improve: no truncation? | Ingest card language OK? | Notes |
|---|---|---|---|---|---|
| EN  |  |  |  |  |  |
| JA  |  |  |  |  |  |
| ZH  |  |  |  |  |  |
