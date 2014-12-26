'''
Created on 2014-10-28

@author: didia
'''
from google.appengine.ext import ndb

from .custom_exceptions import BadArgumentError
from .task import Task
from trackdidia.models.calendar import Week
from trackdidia.models.calendar import Day
from trackdidia.models.scheduled_task import ScheduledTask
from trackdidia import constants
from trackdidia.models import utils

def create_user(user_id, email, nickname):
    my_user = User(id=user_id, email=email, nickname=nickname)
    my_user.put()
    my_user.init_calendar()
    monday, saturday = utils.get_week_start_and_end()
    my_user.get_or_create_week(monday, saturday)
    return my_user;

def get_user(user_id):
    return User.get_by_id(user_id)

def get_or_create_user(user_id, email, nickname):
    user = get_user(user_id)
    return user or create_user(user_id, email, nickname)

def get_all_users():
    return User.query().fetch()
    

def delete_user(user_id):
    key = ndb.Key(User, user_id)
    key.delete()
    
class User(ndb.Model):
    '''
    Stores a user information
    '''
    email = ndb.StringProperty(required=True)
    nickname = ndb.StringProperty(required=True)
    week = None
    _tasks = None
    
    
    def update(self, **kwargs):
        if not kwargs is None:
            updated_values = {}
            for key, value in kwargs.iteritems():
                if not value is None:
                    updated_values[key] = value
            
            self.populate(**updated_values)
            self.put()
    
    def get_or_create_week(self, monday, saturday):
        week_id = monday.strftime(constants.WEEK_ID_FORMAT) + saturday.strftime(constants.WEEK_ID_FORMAT)
        week = Week(id = week_id, parent = self.key)
        week.initialize()
        weekly_schedule = self.get_week(constants.RECURRENCE_TYPES[2])
        
        for recurrent_day in weekly_schedule.get_all_days():
            new_scheduled_tasks = []
            day = week.get_day(recurrent_day.key.integer_id())
            for scheduled_task in recurrent_day.get_scheduled_tasks():
                new_key = ndb.Key(flat=[ScheduledTask, scheduled_task.key.id()], parent = day.key)
                scheduled_task.key = new_key
                for i in range(scheduled_task.offset, scheduled_task.offset+scheduled_task.duration):
                    day.interval_usage[i] = True
                
                new_scheduled_tasks.append(scheduled_task)
            new_scheduled_tasks.append(day)
            ndb.put_multi(new_scheduled_tasks)
        
                        
        week.put()
        return week
    
    def create_task(self, name, **kwargs):
        self._tasks = None
        if(self.has_task(name)):
            raise BadArgumentError("A task with name < " + name + " > already exists")
        task = Task(parent = self.key, name=name, **kwargs)
        task.put()
        return task
    
    def has_task(self, task_name):
        return Task.query(ancestor = self.key).filter(Task.name ==task_name).get() != None;
                    
    def get_task(self, task_id):
        task = Task.get_by_id(task_id, parent = self.key)
        return task
    
    def get_task_by_name(self, task_name):
        return Task.query(ancestor = self.key).filter(Task.name ==task_name).get()
    
    def get_all_tasks(self):
        if self._tasks is None:
            self._tasks = Task.query(ancestor=self.key).order(Task.name).fetch()
        return self._tasks
        
    def update_task(self, task_id, **kwargs):
        self._tasks = None
        task = Task.get_by_id(task_id, parent = self.key)
        if(kwargs.get('name') and task.name != kwargs.get('name') and 
           self.has_task(kwargs.get('name'))):
            raise BadArgumentError("A task with name < " + kwargs.get('name') + " > already exists")
            
        return task.update(**kwargs)
        
    
    def delete_task(self, task_id):
        key = ndb.Key(Task, task_id, parent = self.key)
        key.delete()
    
    def init_calendar(self):
        if self.get_week() is None:
            week = Week(id=constants.RECURRENCE_TYPES[2], parent=self.key)
            week.initialize()
            week.add_default_sleep_task()
            week.put()
            self.week = week
        return week
    
    def get_week(self, week_id='current'):
        if week_id == 'current':
            week_id = utils.get_week_id()
        if self.week is None or self.week.key.id() != week_id:
            self.week = Week.get_by_id(week_id, parent=self.key)
        return self.week
    
    def get_current_week(self):
        return self.get_week('current')
       