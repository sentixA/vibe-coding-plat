"""
搜索辅助工具（测试 fixture，Python 版本）
提供文本预处理、分词和简单 TF-IDF 计算。
"""
import re
import math
from collections import Counter
from typing import List, Dict, Tuple


def tokenize(text: str) -> List[str]:
    """简单分词：转小写，按非字母数字分割"""
    return re.findall(r'[a-zA-Z0-9]+', text.lower())


def term_frequency(tokens: List[str]) -> Dict[str, float]:
    """计算词频（TF）"""
    if not tokens:
        return {}
    counter = Counter(tokens)
    total = len(tokens)
    return {term: count / total for term, count in counter.items()}


def inverse_document_frequency(
    term: str, documents: List[List[str]]
) -> float:
    """计算逆文档频率（IDF）"""
    doc_count = sum(1 for doc in documents if term in doc)
    if doc_count == 0:
        return 0.0
    return math.log(len(documents) / doc_count)


def tfidf_score(query: str, document: str, corpus: List[str]) -> float:
    """计算 query 相对于 document 的 TF-IDF 分数"""
    query_tokens = tokenize(query)
    doc_tokens = tokenize(document)
    corpus_tokens = [tokenize(d) for d in corpus]

    tf = term_frequency(doc_tokens)
    score = 0.0
    for term in query_tokens:
        idf = inverse_document_frequency(term, corpus_tokens)
        score += tf.get(term, 0.0) * idf
    return score


def rank_documents(
    query: str, documents: List[str]
) -> List[Tuple[int, float]]:
    """对文档列表按 TF-IDF 分数降序排名，返回 (index, score) 列表"""
    scored = [
        (i, tfidf_score(query, doc, documents))
        for i, doc in enumerate(documents)
    ]
    return sorted(scored, key=lambda x: x[1], reverse=True)
