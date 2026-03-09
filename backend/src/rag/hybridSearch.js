// Hybrid search: BM25 (keyword) + semantic (ChromaDB) combined with Reciprocal Rank Fusion (RRF)

const config = require("./config");
const { generateEmbedding } = require("./embeddings");
const { searchSemantic } = require("./chromaClient");
const { searchBM25 } = require("./bm25");

/*----------------------------------------------------------------------------------------------
  Reciprocal Rank Fusion (RRF):
    score(doc) = 1/(K + rank_bm25) + 1/(K + rank_semantic)
  Combines two ranked lists into one, giving weight to documents that appear high in both lists
-----------------------------------------------------------------------------------------------*/

// Hybrid search for an exercise -> Returns top results sorted by combined score (highest first)
async function hybridSearch(query, exerciseNum, topK = config.TOP_K_FINAL) {
  // 1. Generate query embedding for semantic search
  const queryEmbedding = await generateEmbedding(query);

  // 2. Run both searches
  const collectionName = "exercise_" + exerciseNum;
  const bm25Results = searchBM25(query, exerciseNum);
  const semanticResults = await searchSemantic(queryEmbedding, collectionName);

  // 3. Build RRF score map using document index as key
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
  return results.slice(0, topK);
}

module.exports = { hybridSearch };
