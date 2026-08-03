CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  content text NOT NULL,
  source_type text NOT NULL
    CONSTRAINT documents_source_type_check
    CHECK (source_type IN ('markdown', 'text')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL
);

CREATE TABLE document_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL
    REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL
    CONSTRAINT document_chunks_chunk_index_check
    CHECK (chunk_index >= 0),
  content text NOT NULL,
  embedding vector(1024) NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE question_logs (
  id uuid PRIMARY KEY,
  question text NOT NULL,
  answer text NOT NULL,
  refused boolean NOT NULL,
  refusal_reason text
    CONSTRAINT question_logs_refusal_reason_check
    CHECK (
      refusal_reason IS NULL OR
      refusal_reason IN (
        'no_chunks',
        'low_similarity',
        'model_refused',
        'empty_answer',
        'invalid_model_output',
        'invalid_citation'
      )
    ),
  answer_model text NOT NULL,
  embedding_model text NOT NULL,
  rag_top_k integer NOT NULL
    CONSTRAINT question_logs_rag_top_k_check
    CHECK (rag_top_k BETWEEN 1 AND 20),
  rag_max_distance double precision NOT NULL
    CONSTRAINT question_logs_rag_max_distance_check
    CHECK (rag_max_distance >= 0),
  prompt_version text NOT NULL,
  retrieval_ms integer NOT NULL
    CONSTRAINT question_logs_retrieval_ms_check
    CHECK (retrieval_ms >= 0),
  generation_ms integer,
  created_at timestamptz NOT NULL,
  CONSTRAINT question_logs_refused_reason_consistency_check
    CHECK (refused = (refusal_reason IS NOT NULL)),
  CONSTRAINT question_logs_generation_ms_check
    CHECK (
      (
        refusal_reason IS NOT NULL AND
        refusal_reason IN ('no_chunks', 'low_similarity') AND
        generation_ms IS NULL
      ) OR (
        (
          refusal_reason IS NULL OR
          refusal_reason IN (
            'model_refused',
            'empty_answer',
            'invalid_model_output',
            'invalid_citation'
          )
        ) AND
        generation_ms IS NOT NULL AND
        generation_ms >= 0
      )
    )
);

CREATE TABLE question_log_hits (
  id uuid PRIMARY KEY,
  question_log_id uuid NOT NULL
    REFERENCES question_logs(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL,
  source_chunk_id uuid NOT NULL,
  document_title text NOT NULL,
  chunk_content text NOT NULL,
  rank integer NOT NULL
    CONSTRAINT question_log_hits_rank_check
    CHECK (rank >= 1),
  distance double precision NOT NULL
    CONSTRAINT question_log_hits_distance_check
    CHECK (distance >= 0),
  passed_threshold boolean NOT NULL,
  cited boolean NOT NULL,
  UNIQUE (question_log_id, rank),
  CONSTRAINT question_log_hits_cited_threshold_check
    CHECK (NOT cited OR passed_threshold)
);

CREATE TABLE feedback (
  id uuid PRIMARY KEY,
  question_log_id uuid NOT NULL UNIQUE
    REFERENCES question_logs(id) ON DELETE CASCADE,
  rating text NOT NULL
    CONSTRAINT feedback_rating_check
    CHECK (rating IN ('helpful', 'not_helpful')),
  created_at timestamptz NOT NULL
);

CREATE TABLE review_queue (
  id uuid PRIMARY KEY,
  question_log_id uuid NOT NULL UNIQUE
    REFERENCES question_logs(id) ON DELETE CASCADE,
  item_type text NOT NULL
    CONSTRAINT review_queue_item_type_check
    CHECK (item_type IN ('refusal', 'not_helpful')),
  status text NOT NULL
    CONSTRAINT review_queue_status_check
    CHECK (status IN ('open', 'resolved')),
  note text
    CONSTRAINT review_queue_note_length_check
    CHECK (note IS NULL OR char_length(note) <= 1000),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CONSTRAINT review_queue_resolution_check
    CHECK (
      (status = 'open' AND resolved_at IS NULL) OR
      (status = 'resolved' AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX document_chunks_embedding_hnsw_idx
  ON document_chunks
  USING hnsw (embedding vector_cosine_ops);

CREATE FUNCTION prevent_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '表 % 是不可变审计日志，不允许 %', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
  RETURN OLD;
END;
$$;

CREATE TRIGGER question_logs_immutable
  BEFORE UPDATE OR DELETE ON question_logs
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();

CREATE TRIGGER question_log_hits_immutable
  BEFORE UPDATE OR DELETE ON question_log_hits
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_mutation();
