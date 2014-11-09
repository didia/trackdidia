
 /**
 * @author Thefuture2092
 *
 */

"use strict";

 define(["models/Slot"], function(Slot){
 	
 	function Day(day_data) {
 		this.id = day_data.day_id;
 		this.usage = day_data.interval_usage;
 		this.slots = this._initSlots(day_data.slots);
 		this.links = day_data.links;
 	}

 	Day.prototype = {
 		constructor: Day,

 		_initSlots: function(listOfSlots) {
 			var slots = {};
 			listOfSlots.forEach(function(slot_data) {
 				var slot = new Slot(slot_data);
 				slots[slot.offset] = slot;
 			});
 			return slots;


 		},
 		
 		getNumberOfTasks: function() {
 			return slots.length;
 		},

 		getNumberOfCompletedTask: function() {
 			var completed = 0;
 			for(var slot in this.slots) {
 				slot.executed?completed += 1:null;
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