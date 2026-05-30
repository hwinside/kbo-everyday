-- Allow explicitly marked operators to moderate community comments.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS is_operator BOOLEAN DEFAULT false;

COMMENT ON COLUMN profiles.is_operator IS
  'Internal operator flag. Operators can delete community comments for moderation.';

DROP POLICY IF EXISTS "Operators delete any comments" ON comments;
CREATE POLICY "Operators delete any comments" ON comments
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM profiles p
      WHERE p.id = auth.uid()
        AND p.is_operator = true
    )
  );
