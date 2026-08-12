-- Records that a user declined the offer to rename their seeded categories into their own
-- language (#162). Additive and nullable, so every existing row starts in the "never dismissed"
-- state, which is what it means: the offer has not been made yet.
--
-- This is the ONLY part of that prompt that is stored. Whether the prompt should appear is derived
-- per request from the categories themselves and the reader's language; see the docstring on
-- User.categoryRenamePromptDismissedAt in prisma/schema.prisma for why the split falls that way.
-- Accepting the rename does not write here.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "categoryRenamePromptDismissedAt" TIMESTAMP(3);
