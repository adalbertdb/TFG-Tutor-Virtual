// Hybrid search: BM25 (keyword) + semantic (ChromaDB) combined with Reciprocal Rank Fusion (RRF)

const config = require("./config");
const { generateEmbedding } = require("./embeddings");
const { searchSemantic } = require("./chromaClient");
const { searchBM25 } = require("./bm25");
const { emitEvent } = require("./ragEventBus");

/*----------------------------------------------------------------------------------------------
  Reciprocal Rank Fusion (RRF):
    score(doc) = 1/(K + rank_bm25) + 1/(K + rank_semantic)
  Combines two ranked lists into one, giving weight to documents that appear high in both lists
-----------------------------------------------------------------------------------------------*/

// Hybrid search for an exercise -> Returns top results sorted by combined score (highest first)
async function hybridSearch(query, exerciseNum, topK = config.TOP_K_FINAL) {
  // 1. Generate query embedding for semantic search
  emitEvent("embedding_start", "start", { query: query, model: config.EMBEDDING_MODEL });
  var embedStart = Date.now();
  const queryEmbedding = await generateEmbedding(query);
  emitEvent("embedding_end", "end", { vectorDimensions: queryEmbedding.length, durationMs: Date.now() - embedStart });

  // 2. Run both searches
  const collectionName = "exercise_" + exerciseNum;
  emitEvent("bm25_search_start", "start", { query: query, exerciseNum: exerciseNum, topK: config.TOP_K_RETRIEVAL, k1: config.BM25_K1, b: config.BM25_B });
  const bm25Results = searchBM25(query, exerciseNum);
  emitEvent("bm25_search_end", "end", { resultCount: bm25Results.length, topScore: bm25Results.length > 0 ? bm25Results[0].score : 0, results: bm25Results.slice(0, 3).map(function(r) { return { index: r.index, score: r.score }; }) });

  emitEvent("semantic_search_start", "start", { collectionName: collectionName, topK: config.TOP_K_RETRIEVAL, embeddingDim: queryEmbedding.length });
  const semanticResults = await searchSemantic(queryEmbedding, collectionName);
  emitEvent("semantic_search_end", "end", { resultCount: semanticResults.length, topScore: semanticResults.length > 0 ? semanticResults[0].score : 0, results: semanticResults.slice(0, 3).map(function(r) { return { id: r.id, score: r.score }; }) });

  // 3. Build RRF score map using document index as key
  emitEvent("rrf_fusion_start", "start", { bm25Count: bm25Results.length, semanticCount: semanticResults.length, RRF_K: config.RRF_K, TOP_K_FINAL: topK });
  const rrfScores = {};

  // Add BM25 ranks
  for (let i = 0; i < bm25Results.length; i++) {
    const key = bm25Results[i].index;
    if (rrfScores[key] == null) {
      rrfScores[key] = {
        student: bm25Results[i].student,
        tutor: bm25Results[i].tutor,
        index: key,
        score: 0,
      };
    }
    rrfScores[key].score += 1 / (config.RRF_K + i + 1);
  }

  // Add semantic ranks
  for (let i = 0; i < semanticResults.length; i++) {
    // The semantic result id format is "ex{num}_{index}"
    const parts = semanticResults[i].id.split("_");
    const key = Number(parts[1]);
    if (rrfScores[key] == null) {
      rrfScores[key] = {
        student: semanticResults[i].document,
        tutor: semanticResults[i].metadata.tutor_response,
        index: key,
        score: 0,
      };
    }
    rrfScores[key].score += 1 / (config.RRF_K + i + 1);
  }

  // 4. Sort by the combined score and return top results
  const keys = Object.keys(rrfScores);
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    results.push(rrfScores[keys[i]]);
  }

  results.sort((a, b) => b.score - a.score);
  var finalResults = results.slice(0, topK);
  emitEvent("rrf_fusion_end", "end", { resultCount: finalResults.length, topScore: finalResults.length > 0 ? finalResults[0].score : 0, formula: "1/(K+rank_bm25) + 1/(K+rank_semantic)" });
  return finalResults;
}

module.exports = { hybridSearch };
