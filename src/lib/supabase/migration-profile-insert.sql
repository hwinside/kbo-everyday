-- Run this in Supabase SQL Editor
CREATE POLICY "Users create own" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
