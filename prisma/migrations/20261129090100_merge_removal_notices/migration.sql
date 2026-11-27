-- msfts §7: removal / suspension notices become ordinary in-app notifications.
INSERT INTO "user_notifications" ("id", "userId", "groupId", "type", "audience", "title", "body", "metadata", "readAt", "createdAt", "deliveredVia")
SELECT
  r."id",
  r."userId",
  CASE WHEN EXISTS (SELECT 1 FROM "groups" g WHERE g."id" = r."groupId") THEN r."groupId" ELSE NULL END,
  CASE WHEN r."kind" = 'REMOVED' THEN 'REMOVED_FROM_GROUP'::"NotificationType" ELSE 'SUSPENDED_IN_GROUP'::"NotificationType" END,
  'MEMBER'::"NotificationAudience",
  CASE WHEN r."kind" = 'REMOVED' THEN 'Removed from ' || r."groupName" ELSE 'Suspended in ' || r."groupName" END,
  r."reason",
  jsonb_build_object('groupName', r."groupName", 'kind', r."kind"::text, 'reason', r."reason"),
  r."readAt",
  r."createdAt",
  ARRAY[]::"NotificationChannel"[]
FROM "group_removal_notifications" r
ON CONFLICT ("id") DO NOTHING;

DROP TABLE "group_removal_notifications";
DROP TYPE "GroupRemovalKind";
