#pragma once
#include <pandoeditor/timeline-records.h>

namespace pandoeditor {
TimelineRecords replaceGeometryBindingAtMonth(const TimelineRecords&, const ObjectRef& objectRef,
                                               const std::string& month, GeometryRef next, std::optional<std::string> rendering = {});
TimelineRecords replaceParentRelationAtMonth(const TimelineRecords&, const ObjectRef& objectRef,
                                              const std::string& month, const std::string& parentId,
                                              const std::string& coverageMode);
TimelineRecords truncateTimelineEntityAtMonth(const TimelineRecords&, const ObjectRef& objectRef,
                                              const std::string& month, bool preserveFutureChanges = false);
TimelineRecords replacePropertyBindingAtMonth(const TimelineRecords&, const ObjectRef& objectRef,
    const std::string& month, const std::string& property, const std::string& value);
}
