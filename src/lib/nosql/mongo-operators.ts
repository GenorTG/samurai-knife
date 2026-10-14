/**
 * MongoDB operator tables. Every list below was read from the official manual (MongoDB 9.0 "current"), the
 * `$operator` index pages, on 2026-10-07; the URL sits next to each list so the next person can re-check it.
 */

/** https://www.mongodb.com/docs/manual/reference/mql/query-predicates/ (alphabetical list of operators). */
export const QUERY_OPERATORS = [
  "$all", "$and", "$bitsAllClear", "$bitsAllSet", "$bitsAnyClear", "$bitsAnySet", "$elemMatch", "$eq", "$exists",
  "$expr", "$geoIntersects", "$geoWithin", "$gt", "$gte", "$in", "$jsonSchema", "$lt", "$lte", "$mod", "$ne",
  "$near", "$nearSphere", "$nin", "$nor", "$not", "$or", "$regex", "$size", "$type", "$where",
  // Miscellaneous predicates documented on the same section: https://www.mongodb.com/docs/manual/reference/mql/query-predicates/misc/
  "$comment", "$rand", "$sampleRate", "$text", "$options",
  // $text / $near / $geoWithin sub-operators: https://www.mongodb.com/docs/manual/reference/operator/query/text/
  "$search", "$language", "$caseSensitive", "$diacriticSensitive", "$geometry", "$box", "$center", "$centerSphere",
  "$polygon", "$maxDistance", "$minDistance", "$uniqueDocs",
] as const;

/** Operators that may appear as a top-level key of a filter document. */
export const TOP_LEVEL_FILTER_OPERATORS = ["$and", "$or", "$nor", "$expr", "$text", "$where", "$comment", "$jsonSchema", "$rand", "$sampleRate"] as const;

/** https://www.mongodb.com/docs/manual/reference/mql/update/ (Fields, Arrays, Modifiers, Bitwise). */
export const UPDATE_OPERATORS = [
  "$currentDate", "$inc", "$min", "$max", "$mul", "$rename", "$set", "$setOnInsert", "$unset",
  "$addToSet", "$pop", "$pull", "$push", "$pullAll",
  "$bit",
] as const;
export const UPDATE_MODIFIERS = ["$each", "$position", "$slice", "$sort"] as const;

/** https://www.mongodb.com/docs/manual/reference/mql/aggregation-stages/ */
export const AGGREGATION_STAGES = [
  "$addFields", "$bucket", "$bucketAuto", "$changeStream", "$changeStreamSplitLargeEvent", "$collStats", "$count",
  "$currentOp", "$densify", "$documents", "$facet", "$fill", "$geoNear", "$graphLookup", "$group", "$indexStats",
  "$limit", "$listClusterCatalog", "$listLocalSessions", "$listSampledQueries", "$listSearchIndexes", "$listSessions",
  "$lookup", "$match", "$merge", "$out", "$planCacheStats", "$project", "$querySettings", "$queryStats", "$rankFusion",
  "$redact", "$replaceRoot", "$replaceWith", "$sample", "$score", "$scoreFusion", "$search", "$searchMeta",
  "$setWindowFields", "$shardedDataDistribution", "$skip", "$sort", "$sortByCount", "$unionWith", "$unset", "$unwind",
  "$vectorSearch", "$set",
] as const;

/** Stages that must come first in a pipeline, and the reason. */
export const FIRST_STAGE_ONLY: Record<string, string> = {
  $geoNear: "$geoNear must be the first stage of the pipeline",
  $search: "$search must be the first stage (Atlas Search only)",
  $searchMeta: "$searchMeta must be the first stage (Atlas Search only)",
  $vectorSearch: "$vectorSearch must be the first stage (Atlas Vector Search only)",
  $documents: "$documents must be the first stage",
  $collStats: "$collStats must be the first stage",
  $indexStats: "$indexStats must be the first stage",
  $changeStream: "$changeStream must be the first stage",
  $queryStats: "$queryStats must be the first stage",
  $currentOp: "$currentOp must be the first stage",
};

/** Stages that write to a collection and so must be last. */
export const LAST_STAGE_ONLY = ["$out", "$merge"] as const;

/** Stages whose names are only valid on Atlas (not a self-managed mongod). */
export const ATLAS_ONLY_STAGES = ["$search", "$searchMeta", "$vectorSearch", "$listSearchIndexes", "$rankFusion", "$scoreFusion", "$score"] as const;

/**
 * Aggregation expression operators, https://www.mongodb.com/docs/manual/reference/mql/expressions/ (all families:
 * arithmetic, array, boolean, comparison, conditional, date, object, set, string, type, trig, window, ...)
 * plus accumulators from https://www.mongodb.com/docs/manual/reference/mql/accumulators/.
 */
export const EXPRESSION_OPERATORS = [
  "$abs", "$accumulator", "$acos", "$acosh", "$add", "$allElementsTrue", "$and", "$anyElementTrue", "$arrayElemAt",
  "$arrayToObject", "$asin", "$asinh", "$atan", "$atan2", "$atanh", "$avg", "$binarySize", "$bitAnd", "$bitNot",
  "$bitOr", "$bitXor", "$bottom", "$bottomN", "$bsonSize", "$ceil", "$cmp", "$concat", "$concatArrays", "$cond",
  "$convert", "$cos", "$cosh", "$count", "$covariancePop", "$covarianceSamp", "$createObjectId", "$dateAdd",
  "$dateDiff", "$dateFromParts", "$dateFromString", "$dateSubtract", "$dateToParts", "$dateToString", "$dateTrunc",
  "$dayOfMonth", "$dayOfWeek", "$dayOfYear", "$degreesToRadians", "$denseRank", "$derivative", "$deserializeEJSON",
  "$divide", "$documentNumber", "$eq", "$exp", "$expMovingAvg", "$filter", "$first", "$firstN", "$floor", "$function",
  "$getField", "$gt", "$gte", "$hash", "$hexHash", "$hour", "$ifNull", "$in", "$indexOfArray", "$indexOfBytes",
  "$indexOfCP", "$integral", "$isArray", "$isNumber", "$isoDayOfWeek", "$isoWeek", "$isoWeekYear", "$last", "$lastN",
  "$let", "$linearFill", "$literal", "$ln", "$locf", "$log", "$log10", "$lt", "$lte", "$ltrim", "$map", "$max",
  "$maxN", "$median", "$mergeObjects", "$meta", "$millisecond", "$min", "$minMaxScaler", "$minN", "$minute", "$mod",
  "$month", "$multiply", "$ne", "$not", "$objectToArray", "$or", "$percentile", "$pow", "$push", "$radiansToDegrees",
  "$rand", "$range", "$rank", "$reduce", "$regexFind", "$regexFindAll", "$regexMatch", "$replaceAll", "$replaceOne",
  "$reverseArray", "$round", "$rtrim", "$sampleRate", "$second", "$serializeEJSON", "$setDifference", "$setEquals",
  "$setField", "$setIntersection", "$setIsSubset", "$setUnion", "$shift", "$sigmoid", "$similarityCosine",
  "$similarityDotProduct", "$similarityEuclidean", "$sin", "$sinh", "$size", "$slice", "$sortArray", "$split", "$sqrt",
  "$stdDevPop", "$stdDevSamp", "$strLenBytes", "$strLenCP", "$strcasecmp", "$substr", "$substrBytes", "$substrCP",
  "$subtract", "$subtype", "$sum", "$switch", "$tan", "$tanh", "$toArray", "$toBool", "$toDate", "$toDecimal",
  "$toDouble", "$toHashedIndexKey", "$toInt", "$toLong", "$toLower", "$toObject", "$toObjectId", "$toString", "$toUUID",
  "$toUpper", "$top", "$topN", "$trim", "$trunc", "$tsIncrement", "$tsSecond", "$type", "$unsetField", "$week",
  "$year", "$zip", "$addToSet", "$expr",
  // Atlas-only / FLE helpers kept so valid pipelines are not rejected:
  "$encStrContains", "$encStrEndsWith", "$encStrNormalizedEq", "$encStrStartsWith",
] as const;

/** Accumulators allowed as the value of a `$group` field (https://www.mongodb.com/docs/manual/reference/mql/accumulators/). */
export const GROUP_ACCUMULATORS = [
  "$accumulator", "$addToSet", "$avg", "$bottom", "$bottomN", "$concatArrays", "$count", "$first", "$firstN", "$last",
  "$lastN", "$max", "$maxN", "$median", "$mergeObjects", "$min", "$minN", "$percentile", "$push", "$setUnion",
  "$stdDevPop", "$stdDevSamp", "$sum", "$top", "$topN",
] as const;

/** System variables: https://www.mongodb.com/docs/manual/reference/aggregation-variables/ . User variables must start lowercase. */
export const SYSTEM_VARIABLES = ["NOW", "CLUSTER_TIME", "ROOT", "CURRENT", "REMOVE", "DESCEND", "PRUNE", "KEEP", "SEARCH_META", "USER_ROLES"] as const;

/** BSON type aliases accepted by `$type`: https://www.mongodb.com/docs/manual/reference/bson-types/ */
export const BSON_TYPE_ALIASES = [
  "double", "string", "object", "array", "binData", "undefined", "objectId", "bool", "date", "null", "regex",
  "dbPointer", "javascript", "symbol", "javascriptWithScope", "int", "timestamp", "long", "decimal", "minKey",
  "maxKey", "number",
] as const;
export const BSON_TYPE_NUMBERS = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 127] as const;

/** Allowed in an index `partialFilterExpression`: https://www.mongodb.com/docs/manual/reference/method/db.collection.createIndex/ */
export const PARTIAL_FILTER_OPERATORS = ["$eq", "$exists", "$gt", "$gte", "$lt", "$lte", "$type", "$and", "$or", "$in", "$geoWithin", "$geoIntersects"] as const;

/** `createIndex` option names: https://www.mongodb.com/docs/manual/reference/method/db.collection.createIndex/#options */
export const INDEX_OPTIONS = [
  "unique", "name", "partialFilterExpression", "sparse", "expireAfterSeconds", "hidden", "collation", "weights",
  "default_language", "language_override", "textIndexVersion", "2dsphereIndexVersion", "bits", "min", "max",
  "wildcardProjection", "background", "storageEngine", "commitQuorum", "comment",
] as const;
/** Index key directions/types: https://www.mongodb.com/docs/manual/indexes/ */
export const INDEX_KEY_TYPES = ["text", "2dsphere", "2d", "hashed", "columnstore"] as const;

export const REGEX_OPTION_LETTERS = "imxslu";

/** Options of `find` shared by every driver (mongosh cursor methods / PyMongo kwargs / Node FindOptions). */
export const FIND_OPTION_KEYS = [
  "collation", "hint", "maxTimeMS", "comment", "allowDiskUse", "batchSize", "min", "max", "readConcern", "noCursorTimeout",
  "allowPartialResults", "returnKey", "showRecordId",
] as const;
export const AGGREGATE_OPTION_KEYS = ["allowDiskUse", "batchSize", "collation", "hint", "maxTimeMS", "comment", "let", "bypassDocumentValidation", "readConcern", "explain"] as const;
export const UPDATE_OPTION_KEYS = ["upsert", "arrayFilters", "collation", "hint", "let", "comment", "bypassDocumentValidation", "writeConcern"] as const;
export const INSERT_MANY_OPTION_KEYS = ["ordered", "bypassDocumentValidation", "comment", "writeConcern"] as const;
export const DELETE_OPTION_KEYS = ["collation", "hint", "let", "comment", "writeConcern"] as const;
export const COUNT_OPTION_KEYS = ["limit", "skip", "hint", "maxTimeMS", "collation", "comment", "readConcern"] as const;
export const DISTINCT_OPTION_KEYS = ["collation", "maxTimeMS", "comment", "readConcern"] as const;
