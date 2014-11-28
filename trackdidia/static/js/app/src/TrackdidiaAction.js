 /**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["app/trackdidia", "app/constants", "app/event", "models/ScheduledTask"], function(trackdidia, Constants, EventProvider, ScheduleTask) {

 	return {
 		scheduleTask : function(day, request) {
 			
 			var url = day.links["create_scheduled_task"];
 			var method = "POST";

 			console.log(trackdidia);
 			console.log(EventProvider);
 			console.log(Constants);
 			trackdidia.remote(url, method, request, function(response, status) {
 				if(status == "ok") {
 					var taskData;
 					var scheduledTaskData;

 					if(response.task) {
 						taskData = response.task;
 						scheduledTaskData = response.scheduled_task;
 						trackdidia.addTask(taskData);
 					} 
 					else {
 						scheduledTaskData = response;
 					}
 					
 					var scheduledTask = new ScheduleTask(scheduledTaskData);
 					day.scheduledTasks[scheduledTask.offset] = scheduledTask;
 					for(var i = scheduledTask.offset; i < scheduledTask.offset + scheduledTask.duration; i++) {
 						day.usage[i] = true;
 					}
 					EventProvider.fire(Constants.SLOT_CREATED);
 					EventProvider.fire(Constants.CHANGE_EVENT);

 				}
 				else {
 					EventProvider.fire(Constants.CREATE_SLOT_FAILED, response);
 				}
 			});
 		},

 		setExecuted: function(scheduledTask) {
 			var url = scheduledTask.links["set_executed"];
 			var method = "POST";
 			trackdidia.remote(url, method, null, function(response, status){
 				if(status == "ok") {
 					var slotData = response;
 					console.log(slotData);
 					scheduledTask.populate(slotData);
 					EventProvider.fire(Constants.CHANGE_EVENT);
 				}
 				else {

 				}
 			});
 		},
 		deleteSlot: function(day, scheduledTask) {
 			var url = scheduledTask.links["delete"];
 			var method = "POST";
 			trackdidia.remote(url, method, null, function(response, status) {
 				if(status == "ok") {
 					console.log("Delete task executed succesfully");
 					var dayData = response;
 					day.populate(dayData);
 					EventProvider.fire(Constants.CHANGE_EVENT);

 				}
 				else {
 					console.log("Delete Scheduled Task failed");
 				}
 			})
 		}
 	}
 })