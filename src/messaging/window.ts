import { defineCustomEventMessaging } from '@webext-core/messaging/page'

import type { MessagingSchema } from './schema.ts'

export const { onMessage, sendMessage } = defineCustomEventMessaging<MessagingSchema>({
  namespace: 'ember-wallet',
})
