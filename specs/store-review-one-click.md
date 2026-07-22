# Store review one-click approval

## Goal

Give App Store and Google Play review cards the same `그대로 발송` / `CS로 이관`
links as the existing CS relay without letting a link preview publish a public reply.

## Flow

1. The relay creates a `store_review` draft with the public reply body and review `csId`.
2. `GET /api/cs/approve/<token>` only renders a confirmation page.
3. The confirmation `POST` atomically changes `pending` to `approved`.
4. The local five-minute relay claims `approved` rows as `processing`, re-fetches the
   store review, publishes the reply, then marks the draft `sent`.
5. `CS로 이관` continues to open the normal team discussion thread.

## Safety criteria

- Opening or prefetching a Slack link never changes state.
- A store reply is written only after the confirmation POST.
- Concurrent workers cannot publish the same approved row twice.
- A worker crash can be recovered by re-queueing stale `processing` rows; the store is
  re-read before every retry.
- Existing feedback and DM draft behavior is unchanged.

## Verification

- TypeScript and ESLint pass for the changed routes and helper.
- Store draft input smoke covers valid IDs and public reply limits.
- Existing CS links remain pending -> sent, while store links use pending -> approved.
