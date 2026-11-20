-- Dislike, OK and Like: every like saved before OK existed was a single thumb, which OK now is. A
-- Like now means two thumbs, so the old rows become OK; dislikes stay as they were.
UPDATE feedback SET mark = 'ok' WHERE mark = 'like';
