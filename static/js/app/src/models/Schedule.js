 /**
 * @author Thefuture2092
 *
 */

 define(['models/Day'], function(Day){
   
   function Schedule(schedule_data) {
        this.id = schedule_data.id;
        this.starting_date = schedule_data.starting_date;
        this.ending_date = schedule_data.ending_date;
        this.days = initDays(schedule_data.days)
   };

   Schedule.prototype = {
       construtor : Schedule,

       initDays: function(days_data) {
       		days = {}
       		days_data.each(function(day_data) {
       			day = new Day(day_data);
       			days[day.id] = day;
       		});
       		return days;
       }

   }
   return Schedule;

 })