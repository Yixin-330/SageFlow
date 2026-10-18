CREATE INDEX IF NOT EXISTS memory_items_search_text_idx ON memory_items USING GIN (
  to_tsvector('simple',
    COALESCE(document->>'label', '') || ' ' ||
    COALESCE(document->'statement'->>'subject', '') || ' ' ||
    COALESCE(document->'statement'->>'predicate', '') || ' ' ||
    COALESCE(document->'statement'->>'value', '')
  )
);
