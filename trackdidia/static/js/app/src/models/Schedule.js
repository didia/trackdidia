/**
 * @author Thefuture2092
 *
 */

 "use strict";

 define(["models/Day"], function(Day){
   
   function Schedule(schedule_data) {
        this.id = schedule_data.id;
        this.starting_date = schedule_data.starting_date;
        this.ending_date = schedule_data.ending_date;
        this.days = this.initDays(schedule_data.days);
        this.links = schedule_data.links;
   };

   Schedule.prototype = {
       construtor : Schedule,

       initDays: function(days_data) {
       		var days = {}
       		days_data.forEach(function(day_data) {
       			var day = new Day(day_data);
       			days[day.id] = day;
       		});
       		return days;
       }

   }
   return Schedule;

 })