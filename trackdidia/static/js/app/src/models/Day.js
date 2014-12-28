
 /**
 * @author Thefuture2092
 *
 */

"use strict";

 define(["models/ScheduledTask"], function(ScheduledTask){
 	
 	function Day(dayData) {
 		this.populate(dayData);
 	}

 	Day.prototype = {
 		constructor: Day,

 		_initScheduledTasks: function(listOfScheduledTasksData) {
 			var scheduledTasks = {};
 			listOfScheduledTasksData.forEach(function(scheduledTaskData) {
 				var scheduleTask= new ScheduledTask(scheduledTaskData);
 				scheduledTasks[scheduleTask.offset] = scheduleTask;
 			});
 			return scheduledTasks;


 		},

 		populate: function(dayData) {
 			this.id = dayData.id;
 			this.usage = dayData.interval_usage;
 			this.stat = dayData.stat;
 			this.scheduledTasks = this._initScheduledTasks(dayData.scheduled_tasks);
 			this.links = dayData.links;
 		},
 		
 		getNumberOfTasks: function() {
 			return this.scheduledTasks.length;
 		},

 		getNumberOfCompletedTask: function() {
 			var completed = 0;
 			for(var key in this.scheduledTasks) {
 				this.scheduledTasks[key].executed?completed += 1:null;
 			}
 			return completed;
 		},
 		getStartAndFinishHour: function(offset, duration) {
 			var start = 24/this.usage.length * offset;
 			var finish = 24/this.usage.length * (offset+duration);

 			return [start, finish];

 		},

 		getHourFromOffset : function(offset) {
 			return 24/this.usage.length * offset;
 		},
 		
 	}

 	return Day;

 })