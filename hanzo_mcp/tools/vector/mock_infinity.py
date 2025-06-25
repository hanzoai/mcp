"""Mock implementation of infinity_embedded for testing on unsupported platforms."""

import json
import hashlib
import random
from pathlib import Path
from typing import Dict, List, Any, Optional
from datetime import datetime


class MockTable:
    """Mock implementation of an Infinity table."""
    
    def __init__(self, name: str, schema: Dict[str, Any]):
        self.name = name
        self.schema = schema
        self.data = []
        self._id_counter = 0
    
    def insert(self, records: List[Dict[str, Any]]):
        """Insert records into the table."""
        for record in records:
            # Add an internal ID if not present
            if 'id' not in record:
                record['_internal_id'] = self._id_counter
                self._id_counter += 1
            self.data.append(record)
    
    def delete(self, condition: str):
        """Delete records matching condition."""
        # Simple implementation - just clear for now
        self.data = [r for r in self.data if not self._eval_condition(r, condition)]
    
    def output(self, columns: List[str]):
        """Start a query chain."""
        return MockQuery(self, columns)
    
    def _eval_condition(self, record: Dict[str, Any], condition: str) -> bool:
        """Evaluate a simple condition."""
        # Very basic implementation
        if '=' in condition:
            field, value = condition.split('=', 1)
            field = field.strip()
            value = value.strip().strip("'\"")
            return str(record.get(field, '')) == value
        return False


class MockQuery:
    """Mock query builder."""
    
    def __init__(self, table: MockTable, columns: List[str]):
        self.table = table
        self.columns = columns
        self.filters = []
        self.vector_search = None
        self.limit_value = None
    
    def filter(self, condition: str):
        """Add a filter condition."""
        self.filters.append(condition)
        return self
    
    def match_dense(self, column: str, vector: List[float], dtype: str, metric: str, limit: int):
        """Add vector search."""
        self.vector_search = {
            'column': column,
            'vector': vector,
            'dtype': dtype,
            'metric': metric,
            'limit': limit
        }
        self.limit_value = limit
        return self
    
    def to_pl(self):
        """Execute query and return polars-like result."""
        results = self.table.data.copy()
        
        # Apply filters
        for condition in self.filters:
            results = [r for r in results if self.table._eval_condition(r, condition)]
        
        # Apply vector search (mock similarity)
        if self.vector_search:
            # Add mock scores
            for r in results:
                r['score'] = random.uniform(0.5, 1.0)
            # Sort by score
            results.sort(key=lambda x: x.get('score', 0), reverse=True)
            # Limit results
            if self.limit_value:
                results = results[:self.limit_value]
        
        # Return mock polars DataFrame
        return MockDataFrame(results)


class MockDataFrame:
    """Mock polars DataFrame."""
    
    def __init__(self, data: List[Dict[str, Any]]):
        self.data = data
    
    def __len__(self):
        return len(self.data)
    
    def iter_rows(self, named: bool = False):
        """Iterate over rows."""
        if named:
            return iter(self.data)
        else:
            # Return tuples
            if not self.data:
                return iter([])
            keys = list(self.data[0].keys())
            return iter([tuple(row.get(k) for k in keys) for row in self.data])


class MockDatabase:
    """Mock implementation of an Infinity database."""
    
    def __init__(self, name: str):
        self.name = name
        self.tables = {}
    
    def create_table(self, name: str, schema: Dict[str, Any]) -> MockTable:
        """Create a new table."""
        table = MockTable(name, schema)
        self.tables[name] = table
        return table
    
    def get_table(self, name: str) -> MockTable:
        """Get an existing table."""
        if name not in self.tables:
            raise KeyError(f"Table {name} not found")
        return self.tables[name]


class MockInfinity:
    """Mock implementation of Infinity connection."""
    
    def __init__(self, path: str):
        self.path = Path(path)
        self.databases = {}
        # Ensure directory exists
        self.path.mkdir(parents=True, exist_ok=True)
    
    def get_database(self, name: str) -> MockDatabase:
        """Get or create a database."""
        if name not in self.databases:
            self.databases[name] = MockDatabase(name)
        return self.databases[name]
    
    def disconnect(self):
        """Disconnect from Infinity."""
        pass


def connect(path: str) -> MockInfinity:
    """Connect to Infinity (mock implementation)."""
    return MockInfinity(path)