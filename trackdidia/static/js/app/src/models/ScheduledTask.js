 /**
 * @author Thefuture2092
 *
 */

 "use strict";

define(function(){

	function ScheduledTask(scheduledTaskData) {
		this.populate(scheduledTaskData);
	};

	ScheduledTask.prototype = {
		constructor : ScheduledTask,
		populate : function(scheduledTaskData) {
			this.id = scheduledTaskData.id;
			this.offset = scheduledTaskData.offset;
			this.duration = scheduledTaskData.duration;
			this.executed = scheduledTaskData.executed;
			this.task_id = scheduledTaskData.task_id;
			this.links = scheduledTaskData.links;
		}
	};

	return ScheduledTask;
})