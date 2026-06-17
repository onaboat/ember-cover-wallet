import { defineExtensionMessaging } from '@webext-core/messaging'

import type { MessagingSchema } from './schema.ts'

export const { onMessage, sendMessage } = defineExtensionMessaging<MessagingSchema>()
