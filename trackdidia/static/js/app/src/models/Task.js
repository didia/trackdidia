 /**
 * @author Thefuture2092
 *
 */

 "use strict";

define(function(){

	function Task(task_data) {
		this.id = task_data.id;
		this.name = task_data.name;
		this.description = task_data.description;
		this.location = task_data.location;
		this.deleted = task_data.deleted;
		this.priority = task_data.priority;
		this.links = task_data.links;
	};

	Task.prototype = {
		constructor : Task,
	}

	return Task;
})