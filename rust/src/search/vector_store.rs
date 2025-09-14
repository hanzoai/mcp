/// Vector store implementation using LanceDB for local embeddings

use lance::{Dataset, Table};
use lance::arrow::datatypes::{DataType, Field, Schema};
use lance::arrow::array::{Float32Array, StringArray, Int64Array};
use lance::arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;

/// Document structure for vector store
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub content: String,
    pub metadata: serde_json::Value,
    pub embedding: Vec<f32>,
    pub score: f32,
}

/// Symbol structure for code symbols
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    pub symbol_type: String,
    pub file_path: String,
    pub line_number: usize,
    pub signature: Option<String>,
    pub docstring: Option<String>,
    pub embedding: Vec<f32>,
}

/// Memory structure for conversation and knowledge
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memory {
    pub id: String,
    pub memory_type: String,
    pub content: String,
    pub timestamp: i64,
    pub metadata: serde_json::Value,
    pub embedding: Vec<f32>,
}

/// Vector store configuration
#[derive(Debug, Clone)]
pub struct VectorStoreConfig {
    pub data_dir: PathBuf,
    pub embedding_model: String,
    pub dimensions: usize,
    pub index_name: String,
}

impl Default for VectorStoreConfig {
    fn default() -> Self {
        Self {
            data_dir: dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".hanzo")
                .join("lancedb"),
            embedding_model: "all-MiniLM-L6-v2".to_string(),
            dimensions: 384,
            index_name: "default".to_string(),
        }
    }
}

/// LanceDB vector store
pub struct VectorStore {
    config: VectorStoreConfig,
    datasets: std::collections::HashMap<String, Arc<Dataset>>,
}

impl VectorStore {
    /// Create new vector store
    pub async fn new(config: Option<VectorStoreConfig>) -> Result<Self, Box<dyn std::error::Error>> {
        let config = config.unwrap_or_default();
        
        // Create data directory
        fs::create_dir_all(&config.data_dir).await?;
        
        Ok(Self {
            config,
            datasets: std::collections::HashMap::new(),
        })
    }

    /// Initialize tables
    pub async fn initialize(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let tables = vec!["documents", "symbols", "memories", "ast_nodes", "code_chunks"];
        
        for table in tables {
            self.create_table(table).await?;
        }
        
        Ok(())
    }

    /// Create a table with schema
    async fn create_table(&mut self, table_name: &str) -> Result<(), Box<dyn std::error::Error>> {
        let table_path = self.config.data_dir.join(format!("{}.lance", table_name));
        
        // Define schema based on table type
        let schema = match table_name {
            "documents" => Schema::new(vec![
                Field::new("id", DataType::Utf8, false),
                Field::new("content", DataType::Utf8, false),
                Field::new("metadata", DataType::Utf8, false),
                Field::new("embedding", DataType::FixedSizeList(
                    Box::new(Field::new("item", DataType::Float32, false)),
                    self.config.dimensions as i32,
                ), false),
            ]),
            "symbols" => Schema::new(vec![
                Field::new("name", DataType::Utf8, false),
                Field::new("symbol_type", DataType::Utf8, false),
                Field::new("file_path", DataType::Utf8, false),
                Field::new("line_number", DataType::Int64, false),
                Field::new("signature", DataType::Utf8, true),
                Field::new("docstring", DataType::Utf8, true),
                Field::new("embedding", DataType::FixedSizeList(
                    Box::new(Field::new("item", DataType::Float32, false)),
                    self.config.dimensions as i32,
                ), false),
            ]),
            "memories" => Schema::new(vec![
                Field::new("id", DataType::Utf8, false),
                Field::new("memory_type", DataType::Utf8, false),
                Field::new("content", DataType::Utf8, false),
                Field::new("timestamp", DataType::Int64, false),
                Field::new("metadata", DataType::Utf8, false),
                Field::new("embedding", DataType::FixedSizeList(
                    Box::new(Field::new("item", DataType::Float32, false)),
                    self.config.dimensions as i32,
                ), false),
            ]),
            _ => Schema::new(vec![
                Field::new("id", DataType::Utf8, false),
                Field::new("content", DataType::Utf8, false),
                Field::new("embedding", DataType::FixedSizeList(
                    Box::new(Field::new("item", DataType::Float32, false)),
                    self.config.dimensions as i32,
                ), false),
            ]),
        };
        
        // Create dataset if it doesn't exist
        if !table_path.exists() {
            let dataset = Dataset::write(
                &table_path,
                vec![],
                Some(Arc::new(schema)),
            ).await?;
            
            self.datasets.insert(table_name.to_string(), Arc::new(dataset));
        }
        
        Ok(())
    }

    /// Add document to vector store
    pub async fn add_document(&mut self, doc: Document) -> Result<(), Box<dyn std::error::Error>> {
        let embedding = if doc.embedding.is_empty() {
            self.generate_embedding(&doc.content).await?
        } else {
            doc.embedding
        };
        
        // Create record batch
        let batch = RecordBatch::try_new(
            self.get_document_schema(),
            vec![
                Arc::new(StringArray::from(vec![doc.id])),
                Arc::new(StringArray::from(vec![doc.content])),
                Arc::new(StringArray::from(vec![doc.metadata.to_string()])),
                Arc::new(Float32Array::from(embedding)),
            ],
        )?;
        
        // Write to dataset
        self.write_batch("documents", batch).await?;
        
        Ok(())
    }

    /// Add symbol to vector store
    pub async fn add_symbol(&mut self, symbol: Symbol) -> Result<(), Box<dyn std::error::Error>> {
        let text = format!(
            "{} {} {} {}",
            symbol.symbol_type,
            symbol.name,
            symbol.signature.as_ref().unwrap_or(&String::new()),
            symbol.docstring.as_ref().unwrap_or(&String::new())
        );
        
        let embedding = self.generate_embedding(&text).await?;
        
        // Create record batch
        let batch = RecordBatch::try_new(
            self.get_symbol_schema(),
            vec![
                Arc::new(StringArray::from(vec![symbol.name])),
                Arc::new(StringArray::from(vec![symbol.symbol_type])),
                Arc::new(StringArray::from(vec![symbol.file_path])),
                Arc::new(Int64Array::from(vec![symbol.line_number as i64])),
                Arc::new(StringArray::from(vec![symbol.signature])),
                Arc::new(StringArray::from(vec![symbol.docstring])),
                Arc::new(Float32Array::from(embedding)),
            ],
        )?;
        
        // Write to dataset
        self.write_batch("symbols", batch).await?;
        
        Ok(())
    }

    /// Search for similar vectors
    pub async fn search(
        &self,
        query: &str,
        table: &str,
        limit: usize,
        threshold: f32,
    ) -> Result<Vec<Document>, Box<dyn std::error::Error>> {
        let query_embedding = self.generate_embedding(query).await?;
        
        // Perform vector search using LanceDB
        let dataset = self.datasets.get(table)
            .ok_or_else(|| format!("Table {} not found", table))?;
        
        // This would use LanceDB's vector search capabilities
        // For now, return mock results
        Ok(vec![])
    }

    /// Search for similar symbols
    pub async fn search_symbols(
        &self,
        query: &str,
        symbol_type: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Symbol>, Box<dyn std::error::Error>> {
        let query_embedding = self.generate_embedding(query).await?;
        
        // Perform vector search in symbols table
        // Filter by symbol type if specified
        Ok(vec![])
    }

    /// Generate embedding for text
    async fn generate_embedding(&self, text: &str) -> Result<Vec<f32>, Box<dyn std::error::Error>> {
        // This would use sentence-transformers or OpenAI API
        // For now, return mock embedding
        Ok(vec![0.0; self.config.dimensions])
    }

    /// Write batch to dataset
    async fn write_batch(
        &mut self,
        table: &str,
        batch: RecordBatch,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let table_path = self.config.data_dir.join(format!("{}.lance", table));
        
        // Append to existing dataset
        if let Some(dataset) = self.datasets.get_mut(table) {
            // This would append to the dataset
            // Implementation depends on Lance API
        }
        
        Ok(())
    }

    /// Get document schema
    fn get_document_schema(&self) -> Arc<Schema> {
        Arc::new(Schema::new(vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("content", DataType::Utf8, false),
            Field::new("metadata", DataType::Utf8, false),
            Field::new("embedding", DataType::FixedSizeList(
                Box::new(Field::new("item", DataType::Float32, false)),
                self.config.dimensions as i32,
            ), false),
        ]))
    }

    /// Get symbol schema
    fn get_symbol_schema(&self) -> Arc<Schema> {
        Arc::new(Schema::new(vec![
            Field::new("name", DataType::Utf8, false),
            Field::new("symbol_type", DataType::Utf8, false),
            Field::new("file_path", DataType::Utf8, false),
            Field::new("line_number", DataType::Int64, false),
            Field::new("signature", DataType::Utf8, true),
            Field::new("docstring", DataType::Utf8, true),
            Field::new("embedding", DataType::FixedSizeList(
                Box::new(Field::new("item", DataType::Float32, false)),
                self.config.dimensions as i32,
            ), false),
        ]))
    }

    /// Index codebase
    pub async fn index_codebase(&mut self, directory: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let files = self.get_code_files(directory).await?;
        
        for file in files {
            self.index_file(&file).await?;
        }
        
        Ok(())
    }

    /// Index a single file
    async fn index_file(&mut self, file_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let content = fs::read_to_string(file_path).await?;
        let language = detect_language(file_path);
        
        // Extract symbols using tree-sitter
        let symbols = extract_symbols(&content, language).await?;
        
        // Store symbols
        for symbol in symbols {
            self.add_symbol(Symbol {
                name: symbol.name,
                symbol_type: symbol.symbol_type,
                file_path: file_path.to_string_lossy().to_string(),
                line_number: symbol.line_number,
                signature: symbol.signature,
                docstring: symbol.docstring,
                embedding: vec![],
            }).await?;
        }
        
        // Chunk and store document
        let chunks = chunk_code(&content, 1000);
        for (i, chunk) in chunks.iter().enumerate() {
            self.add_document(Document {
                id: format!("{}:{}", file_path.display(), i),
                content: chunk.clone(),
                metadata: serde_json::json!({
                    "file_path": file_path.to_string_lossy(),
                    "chunk_index": i,
                    "language": language,
                }),
                embedding: vec![],
                score: 0.0,
            }).await?;
        }
        
        Ok(())
    }

    /// Get code files from directory
    async fn get_code_files(&self, directory: &Path) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
        let extensions = vec!["rs", "ts", "js", "py", "go", "java", "cpp", "c"];
        let mut files = Vec::new();
        
        let mut entries = fs::read_dir(directory).await?;
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            
            if path.is_dir() && !path.file_name().unwrap_or_default().to_string_lossy().starts_with('.') {
                let sub_files = Box::pin(self.get_code_files(&path)).await?;
                files.extend(sub_files);
            } else if path.is_file() {
                if let Some(ext) = path.extension() {
                    if extensions.contains(&ext.to_str().unwrap_or("")) {
                        files.push(path);
                    }
                }
            }
        }
        
        Ok(files)
    }

    /// Calculate cosine similarity
    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        if a.len() != b.len() {
            return 0.0;
        }
        
        let dot_product: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
        let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
        
        if norm_a == 0.0 || norm_b == 0.0 {
            return 0.0;
        }
        
        dot_product / (norm_a * norm_b)
    }
}

/// Detect language from file extension
fn detect_language(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()) {
        Some("rs") => "rust",
        Some("ts") | Some("tsx") => "typescript",
        Some("js") | Some("jsx") => "javascript",
        Some("py") => "python",
        Some("go") => "go",
        Some("java") => "java",
        Some("cpp") | Some("cc") => "cpp",
        Some("c") => "c",
        _ => "text",
    }
}

/// Extract symbols from code
async fn extract_symbols(content: &str, language: &str) -> Result<Vec<Symbol>, Box<dyn std::error::Error>> {
    // This would use tree-sitter to extract symbols
    // For now, return empty vector
    Ok(vec![])
}

/// Chunk code into segments
fn chunk_code(content: &str, chunk_size: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let lines: Vec<&str> = content.lines().collect();
    let mut current_chunk = String::new();
    
    for line in lines {
        if current_chunk.len() + line.len() > chunk_size && !current_chunk.is_empty() {
            chunks.push(current_chunk.clone());
            current_chunk.clear();
        }
        current_chunk.push_str(line);
        current_chunk.push('\n');
    }
    
    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }
    
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_vector_store() {
        let store = VectorStore::new(None).await;
        assert!(store.is_ok());
    }

    #[test]
    fn test_cosine_similarity() {
        let store = VectorStore::new(None).await.unwrap();
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert_eq!(VectorStore::cosine_similarity(&a, &b), 1.0);
        
        let c = vec![0.0, 1.0, 0.0];
        assert_eq!(VectorStore::cosine_similarity(&a, &c), 0.0);
    }
}