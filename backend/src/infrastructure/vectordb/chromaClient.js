// ChromaDB client for semantic search over datasets and knowledge graph

const { ChromaClient } = require("chromadb");
const config = require("../llm/config");

let client = null;

// Initialize and return the ChromaDB client
function getClient() {
  if (client == null) {
    client = new ChromaClient({ path: config.CHROMA_URL });
  }
  return client;
}

// Get or create a collection with cosine similarity
async function getCollection(name) {
  const chroma = getClient();
  return chroma.getOrCreateCollection({
    name,
    metadata: { "hnsw:space": "cosine" }, // hnsw: hierarchical navigable small world graph for cosine similarity
  });
}

// Add documents with embeddings to a collection
async function addDocuments(collectionName, {ids, documents, embeddings, metadatas}) {
  const collection = await getCollection(collectionName);
  await collection.add({ids, documents, embeddings, metadatas});
}

// Semantic search using query embedding -> Returns results sorted by similarity (highest first)
async function searchSemantic(queryEmbedding, collectionName, topK = config.TOP_K_RETRIEVAL) {
  const collection = await getCollection(collectionName);
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults: topK,
  });

  // Convert ChromaDB arrays to results with similarity scores
  // ChromaDB cosine distance = 1 - cosine_similarity
  const items = [];
  for (let i = 0; i < results.ids[0].length; i++) {
    items.push({
      id: results.ids[0][i],
      document: results.documents[0][i],
      metadata: results.metadatas[0][i],
      score: 1 - results.distances[0][i],
    });
  }
  return items;
}

module.exports = { getClient, getCollection, addDocuments, searchSemantic };
