 /**
 * @author Thefuture2092
 *
 */

"use strict";

 define(['models/Slot'], function(Slot){
 	function Day(day_data) {
 		this.id = day_data.day_id
 		this.usage = day_data.interval_usage
 		this.slots = initSlots(day_data.slots)
 	}

 	Day.prototype = {
 		constructor: Day,

 		initSlots: function(listOfSlots) {
 			slots = {};
 			listOfSlots.each(function(slot_data) {
 				slot = new Slot(slot_data);
 				slots[slot.id] = slot;
 			});
 			return slots;


 		}
 	}

 })